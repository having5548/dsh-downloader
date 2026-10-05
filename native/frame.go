package main

import (
	"encoding/binary"
	"fmt"
	"io"
)

// QUIC-style varint: the top two bits encode the length (1/2/4/8 bytes).

func varintLen(v uint64) int {
	switch {
	case v <= 63:
		return 1
	case v <= 16383:
		return 2
	case v <= 1073741823:
		return 4
	default:
		return 8
	}
}

func appendVarint(b []byte, v uint64) []byte {
	switch {
	case v <= 63:
		return append(b, byte(v))
	case v <= 16383:
		return append(b, byte(v>>8)|0x40, byte(v))
	case v <= 1073741823:
		return append(b, byte(v>>24)|0x80, byte(v>>16), byte(v>>8), byte(v))
	default:
		return append(b, byte(v>>56)|0xc0, byte(v>>48), byte(v>>40), byte(v>>32), byte(v>>24), byte(v>>16), byte(v>>8), byte(v))
	}
}

func readVarint(r io.Reader) (uint64, error) {
	var b [1]byte
	if _, err := io.ReadFull(r, b[:]); err != nil {
		return 0, err
	}
	switch b[0] >> 6 {
	case 0:
		return uint64(b[0]), nil
	case 1:
		var rest [1]byte
		if _, err := io.ReadFull(r, rest[:]); err != nil {
			return 0, err
		}
		return uint64(b[0]&0x3f)<<8 | uint64(rest[0]), nil
	case 2:
		var rest [3]byte
		if _, err := io.ReadFull(r, rest[:]); err != nil {
			return 0, err
		}
		return uint64(b[0]&0x3f)<<24 | uint64(rest[0])<<16 | uint64(rest[1])<<8 | uint64(rest[2]), nil
	default:
		var rest [7]byte
		if _, err := io.ReadFull(r, rest[:]); err != nil {
			return 0, err
		}
		return uint64(b[0]&0x3f)<<56 | binary.BigEndian.Uint64(rest[:]), nil
	}
}

// hysteria2 TCP request frame: 0x401 varint, then addrLen varint + addr,
// then paddingLen varint + padding, then payload.
func writeHysteriaTCPRequest(w io.Writer, addr string, payload []byte) error {
	pad := make([]byte, 64)
	for i := range pad {
		pad[i] = byte('a' + i%26)
	}
	var buf []byte
	buf = appendVarint(buf, 0x401)
	buf = appendVarint(buf, uint64(len(addr)))
	buf = append(buf, addr...)
	buf = appendVarint(buf, uint64(len(pad)))
	buf = append(buf, pad...)
	buf = append(buf, payload...)
	_, err := w.Write(buf)
	return err
}

// hysteria2 TCP response: status byte, msgLen varint + msg, paddingLen varint + padding.
func readHysteriaTCPResponse(r io.Reader) error {
	var status [1]byte
	if _, err := io.ReadFull(r, status[:]); err != nil {
		return err
	}
	msgLen, err := readVarint(r)
	if err != nil {
		return err
	}
	if msgLen > 0 {
		if _, err := io.CopyN(io.Discard, r, int64(msgLen)); err != nil {
			return err
		}
	}
	padLen, err := readVarint(r)
	if err != nil {
		return err
	}
	if padLen > 0 {
		if _, err := io.CopyN(io.Discard, r, int64(padLen)); err != nil {
			return err
		}
	}
	if status[0] != 0 {
		return fmt.Errorf("hysteria2 remote error status %d", status[0])
	}
	return nil
}
