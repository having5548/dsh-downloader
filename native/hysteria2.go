package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
)

const hysteriaAuthPath = "/auth"
const hysteriaAuthHost = "hysteria"
const hysteriaStatusAuthOK = 233

// hysteriaConn wraps a QUIC stream as a net.Conn, lazily writing the TCP
// request frame (which carries the destination address) on the first Write,
// and reading the TCP response frame on the first Read.
type hysteriaConn struct {
	stream   *quic.Stream
	dest     string
	closeAll func()
	reqOnce  sync.Once
	respOnce sync.Once
	writeErr error
	readErr  error
}

func (c *hysteriaConn) Write(p []byte) (int, error) {
	var first bool
	c.reqOnce.Do(func() {
		first = true
		c.writeErr = writeHysteriaTCPRequest(c.stream, c.dest, p)
	})
	if c.writeErr != nil {
		return 0, c.writeErr
	}
	if first {
		return len(p), nil
	}
	n, err := (*c.stream).Write(p)
	return n, err
}

func (c *hysteriaConn) Read(p []byte) (int, error) {
	c.respOnce.Do(func() {
		c.readErr = readHysteriaTCPResponse(c.stream)
	})
	if c.readErr != nil {
		return 0, c.readErr
	}
	return (*c.stream).Read(p)
}

func (c *hysteriaConn) Close() error {
	(*c.stream).CancelRead(0)
	err := (*c.stream).Close()
	if c.closeAll != nil {
		c.closeAll()
	}
	return err
}

func (c *hysteriaConn) LocalAddr() net.Addr  { return addr("") }
func (c *hysteriaConn) RemoteAddr() net.Addr { return addr("") }
func (c *hysteriaConn) SetDeadline(t time.Time) error {
	_ = (*c.stream).SetDeadline(t)
	return nil
}
func (c *hysteriaConn) SetReadDeadline(t time.Time) error {
	_ = (*c.stream).SetReadDeadline(t)
	return nil
}
func (c *hysteriaConn) SetWriteDeadline(t time.Time) error {
	_ = (*c.stream).SetWriteDeadline(t)
	return nil
}

type addr string

func (addr) Network() string { return "hysteria2" }
func (a addr) String() string { return string(a) }

func dialHysteria2(node *NodeConfig, dest string) (net.Conn, error) {
	serverAddr := fmt.Sprintf("%s:%d", node.Server, node.Port)
	sni := node.SNI
	if sni == "" {
		sni = node.Server
	}
	tlsConfig := &tls.Config{
		ServerName:         sni,
		InsecureSkipVerify: node.SkipCertVerify,
		NextProtos:         []string{http3.NextProtoH3},
	}
	quicConfig := &quic.Config{
		MaxIdleTimeout:  90 * time.Second,
		KeepAlivePeriod: 25 * time.Second,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	quicConn, closeTransport, err := dialHysteriaQUIC(ctx, serverAddr, node, tlsConfig, quicConfig)
	if err != nil {
		return nil, fmt.Errorf("hysteria2 quic dial: %w", err)
	}

	transport := &http3.Transport{
		TLSClientConfig: tlsConfig,
		QUICConfig:      quicConfig,
	}
	clientConn := transport.NewClientConn(quicConn)

	request := &http.Request{
		Method: http.MethodPost,
		URL: &url.URL{
			Scheme: "https",
			Host:   hysteriaAuthHost,
			Path:   hysteriaAuthPath,
		},
		Header: make(http.Header),
	}
	request.Header.Set("Hysteria-Auth", node.Password)
	request.Header.Set("Hysteria-CC-RX", "0")

	response, err := clientConn.RoundTrip(request)
	if err != nil {
		quicConn.CloseWithError(0, "")
		return nil, fmt.Errorf("hysteria2 auth: %w", err)
	}
	_ = response.Body.Close()
	if response.StatusCode != hysteriaStatusAuthOK {
		quicConn.CloseWithError(0, "")
		return nil, fmt.Errorf("hysteria2 auth failed, status %d", response.StatusCode)
	}

	stream, err := quicConn.OpenStreamSync(ctx)
	if err != nil {
		quicConn.CloseWithError(0, "")
		return nil, fmt.Errorf("hysteria2 open stream: %w", err)
	}

	// Ensure the QUIC connection stays alive for the stream's lifetime.
	conn := &hysteriaConn{stream: stream, dest: dest, closeAll: closeTransport}
	return conn, nil
}

// dialHysteriaQUIC dials QUIC over our own UDP socket so the salamander obfs
// wrapper can sit underneath quic-go. quic.DialAddr would create a socket we
// could not reach, and without obfs the server drops every packet.
func dialHysteriaQUIC(ctx context.Context, serverAddr string, node *NodeConfig, tlsConfig *tls.Config, quicConfig *quic.Config) (*quic.Conn, func(), error) {
	remoteAddr, err := net.ResolveUDPAddr("udp", serverAddr)
	if err != nil {
		return nil, nil, err
	}
	network := "udp4"
	local := &net.UDPAddr{IP: net.IPv4zero, Port: 0}
	if remoteAddr.IP.To4() == nil {
		network = "udp6"
		local = &net.UDPAddr{IP: net.IPv6unspecified, Port: 0}
	}
	udpConn, err := net.ListenUDP(network, local)
	if err != nil {
		return nil, nil, err
	}
	transport := &quic.Transport{Conn: newSalamanderPacketConn(udpConn, node.ObfsPassword)}
	quicConn, err := transport.Dial(ctx, remoteAddr, tlsConfig, quicConfig)
	if err != nil {
		_ = transport.Close()
		return nil, nil, err
	}
	return quicConn, func() { _ = transport.Close() }, nil
}
