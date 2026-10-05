package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"net"
	"reflect"
	"time"
	"unsafe"

	utls "github.com/metacubex/utls"
	"golang.org/x/crypto/hkdf"
)

// realityVerifier verifies the temporary certificate the reality server mints.
type realityVerifier struct {
	*utls.UConn
	serverName string
	authKey    []byte
	verified   bool
}

func (c *realityVerifier) VerifyPeerCertificate(rawCerts [][]byte, verifiedChains [][]*x509.Certificate) error {
	p, _ := reflect.TypeFor[utls.Conn]().FieldByName("peerCertificates")
	certs := *(*([]*x509.Certificate))(unsafe.Add(unsafe.Pointer(c.Conn), p.Offset))
	if pub, ok := certs[0].PublicKey.(ed25519.PublicKey); ok {
		h := hmac.New(sha512.New, c.authKey)
		h.Write(pub)
		if bytes.Equal(h.Sum(nil), certs[0].Signature) {
			c.verified = true
			return nil
		}
	}
	opts := x509.VerifyOptions{DNSName: c.serverName, Intermediates: x509.NewCertPool()}
	for _, cert := range certs[1:] {
		opts.Intermediates.AddCert(cert)
	}
	_, err := certs[0].Verify(opts)
	return err
}

func dialReality(node *NodeConfig, dest string) (net.Conn, error) {
	serverAddr := fmt.Sprintf("%s:%d", node.Server, node.Port)
	serverName := node.ServerName
	if serverName == "" {
		serverName = node.Server
	}
	publicKey, err := base64.RawURLEncoding.DecodeString(node.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("reality decode public_key: %w", err)
	}
	if len(publicKey) != 32 {
		return nil, fmt.Errorf("reality invalid public_key length %d", len(publicKey))
	}
	var shortID [8]byte
	shortIDBytes, err := hex.DecodeString(node.ShortID)
	if err != nil {
		return nil, fmt.Errorf("reality decode short_id: %w", err)
	}
	if len(shortIDBytes) > 8 {
		return nil, fmt.Errorf("reality invalid short_id")
	}
	copy(shortID[:], shortIDBytes)

	rawConn, err := net.DialTimeout("tcp", serverAddr, 15*time.Second)
	if err != nil {
		return nil, fmt.Errorf("reality tcp dial: %w", err)
	}

	uConfig := &utls.Config{
		ServerName:             serverName,
		InsecureSkipVerify:     true,
		SessionTicketsDisabled: true,
		NextProtos:             []string{"h2", "http/1.1"},
	}
	uConn := utls.UClient(rawConn, uConfig, utls.HelloSafari_Auto)
	verifier := &realityVerifier{serverName: serverName}
	uConfig.VerifyPeerCertificate = verifier.VerifyPeerCertificate
	verifier.UConn = uConn

	if err := uConn.BuildHandshakeState(); err != nil {
		return nil, fmt.Errorf("reality build handshake: %w", err)
	}
	for _, ext := range uConn.Extensions {
		if ce, ok := ext.(*utls.SupportedCurvesExtension); ok {
			ce.Curves = filterCurve(ce.Curves)
		}
		if ks, ok := ext.(*utls.KeyShareExtension); ok {
			ks.KeyShares = filterKeyShare(ks.KeyShares)
		}
	}
	if err := uConn.BuildHandshakeState(); err != nil {
		return nil, fmt.Errorf("reality rebuild handshake: %w", err)
	}
	for _, ext := range uConn.Extensions {
		if alpn, ok := ext.(*utls.ALPNExtension); ok {
			alpn.AlpnProtocols = []string{"h2", "http/1.1"}
			break
		}
	}

	hello := uConn.HandshakeState.Hello
	hello.SessionId = make([]byte, 32)
	copy(hello.Raw[39:], hello.SessionId)
	now := time.Now().Unix()
	binary.BigEndian.PutUint64(hello.SessionId, uint64(now))
	hello.SessionId[0] = 1
	hello.SessionId[1] = 8
	hello.SessionId[2] = 1
	binary.BigEndian.PutUint32(hello.SessionId[4:], uint32(now))
	copy(hello.SessionId[8:], shortID[:])

	pub, err := ecdh.X25519().NewPublicKey(publicKey)
	if err != nil {
		return nil, fmt.Errorf("reality x25519 pubkey: %w", err)
	}
	keyShareKeys := uConn.HandshakeState.State13.KeyShareKeys
	if keyShareKeys == nil || keyShareKeys.Ecdhe == nil {
		return nil, fmt.Errorf("reality: no ecdhe key share")
	}
	authKey, err := keyShareKeys.Ecdhe.ECDH(pub)
	if err != nil {
		return nil, fmt.Errorf("reality ecdh: %w", err)
	}
	verifier.authKey = authKey
	_, err = hkdf.New(sha256.New, authKey, hello.Random[:20], []byte("REALITY")).Read(authKey)
	if err != nil {
		return nil, fmt.Errorf("reality hkdf: %w", err)
	}
	aesBlock, _ := aes.NewCipher(authKey)
	aesGcm, _ := cipher.NewGCM(aesBlock)
	aesGcm.Seal(hello.SessionId[:0], hello.Random[20:], hello.SessionId[:16], hello.Raw)
	copy(hello.Raw[39:], hello.SessionId)

	if err := uConn.Handshake(); err != nil {
		return nil, fmt.Errorf("reality handshake: %w", err)
	}
	if !verifier.verified {
		return nil, fmt.Errorf("reality verification failed")
	}

	// vless layer over the verified reality stream.
	vconn, err := newVlessConn(uConn, node, dest)
	if err != nil {
		return nil, err
	}
	if node.Flow == "xtls-rprx-vision" {
		uuid, err := hex.DecodeString(stringsReplace(node.UUID, "-", ""))
		if err != nil {
			return nil, err
		}
		var uuidBytes [16]byte
		copy(uuidBytes[:], uuid)
		return newVisionConn(vconn, uConn, uuidBytes)
	}
	return vconn, nil
}

func filterCurve(curves []utls.CurveID) []utls.CurveID {
	out := curves[:0]
	for _, c := range curves {
		if c != utls.X25519MLKEM768 {
			out = append(out, c)
		}
	}
	return out
}

func filterKeyShare(shares []utls.KeyShare) []utls.KeyShare {
	out := shares[:0]
	for _, s := range shares {
		if s.Group != utls.X25519MLKEM768 {
			out = append(out, s)
		}
	}
	return out
}
