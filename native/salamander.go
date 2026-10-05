package main

import (
	"crypto/rand"
	"net"

	"golang.org/x/crypto/blake2b"
)

// salamanderSaltLen is the random salt prefixed to every datagram.
const salamanderSaltLen = 8

// salamanderPacketConn applies hysteria2's "salamander" obfuscation to every
// datagram: an 8-byte random salt, followed by the payload XORed with a
// BLAKE2b-256 keystream keyed by password||salt. Without it the server simply
// drops our packets — the QUIC handshake never completes.
//
// Mirrors github.com/sagernet/sing-quic/hysteria2 (GPL-3.0) and the hysteria2
// reference; this is the wire format, not an implementation detail.
type salamanderPacketConn struct {
	net.PacketConn
	password []byte
}

// newSalamanderPacketConn wraps conn, or returns it untouched when no password
// is configured (plain hysteria2 servers exist).
func newSalamanderPacketConn(conn net.PacketConn, password string) net.PacketConn {
	if password == "" {
		return conn
	}
	return &salamanderPacketConn{PacketConn: conn, password: []byte(password)}
}

// keystream returns the per-packet key for a salt, without aliasing password.
func (s *salamanderPacketConn) keystream(salt []byte) [blake2b.Size256]byte {
	seed := make([]byte, 0, len(s.password)+len(salt))
	seed = append(seed, s.password...)
	seed = append(seed, salt...)
	return blake2b.Sum256(seed)
}

// SetReadBuffer / SetWriteBuffer keep quic-go's socket tuning working: without
// them the transport logs "connection doesn't allow setting of receive buffer
// size" and falls back to smaller buffers, which costs throughput.
func (s *salamanderPacketConn) SetReadBuffer(bytes int) error {
	if setter, ok := s.PacketConn.(interface{ SetReadBuffer(int) error }); ok {
		return setter.SetReadBuffer(bytes)
	}
	return nil
}

func (s *salamanderPacketConn) SetWriteBuffer(bytes int) error {
	if setter, ok := s.PacketConn.(interface{ SetWriteBuffer(int) error }); ok {
		return setter.SetWriteBuffer(bytes)
	}
	return nil
}

func (s *salamanderPacketConn) ReadFrom(p []byte) (int, net.Addr, error) {
	n, addr, err := s.PacketConn.ReadFrom(p)
	if err != nil || n <= salamanderSaltLen {
		return n, addr, err
	}
	key := s.keystream(p[:salamanderSaltLen])
	for index, c := range p[salamanderSaltLen:n] {
		p[index] = c ^ key[index%blake2b.Size256]
	}
	return n - salamanderSaltLen, addr, nil
}

func (s *salamanderPacketConn) WriteTo(p []byte, addr net.Addr) (int, error) {
	buffer := make([]byte, salamanderSaltLen+len(p))
	if _, err := rand.Read(buffer[:salamanderSaltLen]); err != nil {
		return 0, err
	}
	key := s.keystream(buffer[:salamanderSaltLen])
	for index, c := range p {
		buffer[salamanderSaltLen+index] = c ^ key[index%blake2b.Size256]
	}
	if _, err := s.PacketConn.WriteTo(buffer, addr); err != nil {
		return 0, err
	}
	return len(p), nil
}
