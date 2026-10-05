package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"math/big"
	"net"
	"reflect"
	"time"
	"unsafe"

	utls "github.com/metacubex/utls"
)

// ---- vless request ---------------------------------------------------------

func buildVlessRequest(node *NodeConfig, host string, port uint16) []byte {
	uuid, err := hex.DecodeString(stringsReplace(node.UUID, "-", ""))
	if err != nil {
		panic(fmt.Sprintf("bad uuid: %v", err))
	}
	var addons []byte
	if node.Flow == "xtls-rprx-vision" {
		flowBytes := []byte("xtls-rprx-vision")
		addons = append(addons, 0x0a)
		addons = appendUvarint(addons, uint64(len(flowBytes)))
		addons = append(addons, flowBytes...)
	}
	var buf []byte
	buf = append(buf, 0x00)
	buf = append(buf, uuid...)
	buf = append(buf, byte(len(addons)))
	buf = append(buf, addons...)
	buf = append(buf, 0x01) // cmd TCP
	buf = append(buf, byte(port>>8), byte(port&0xff))
	buf = append(buf, encodeVlessAddr(host)...)
	return buf
}

func encodeVlessAddr(host string) []byte {
	if ip := net.ParseIP(host); ip != nil {
		if ip4 := ip.To4(); ip4 != nil {
			return append([]byte{0x01}, ip4...)
		}
		return append([]byte{0x03}, ip.To16()...)
	}
	b := []byte(host)
	return append([]byte{0x02, byte(len(b))}, b...)
}

func appendUvarint(b []byte, v uint64) []byte {
	for v >= 0x80 {
		b = append(b, byte(v)|0x80)
		v >>= 7
	}
	return append(b, byte(v))
}

func stringsReplace(s, old, new string) string {
	out := ""
	for i := 0; i < len(s); i++ {
		if i+len(old) <= len(s) && s[i:i+len(old)] == old {
			out += new
			i += len(old) - 1
		} else {
			out += s[i : i+1]
		}
	}
	return out
}

// ---- vless logical conn (request on first write, response on first read) ---

type vlessConn struct {
	conn           net.Conn
	request        []byte
	requestWritten bool
	responseRead   bool
}

func newVlessConn(conn net.Conn, node *NodeConfig, dest string) (*vlessConn, error) {
	host, portStr, err := net.SplitHostPort(dest)
	if err != nil {
		return nil, err
	}
	var portNum int
	fmt.Sscanf(portStr, "%d", &portNum)
	return &vlessConn{conn: conn, request: buildVlessRequest(node, host, uint16(portNum))}, nil
}

func (c *vlessConn) Write(b []byte) (int, error) {
	if !c.requestWritten {
		payload := append(append([]byte{}, c.request...), b...)
		if _, err := c.conn.Write(payload); err != nil {
			return 0, err
		}
		c.requestWritten = true
		return len(b), nil
	}
	return c.conn.Write(b)
}

func (c *vlessConn) Read(b []byte) (int, error) {
	if !c.responseRead {
		var head [2]byte
		if _, err := io.ReadFull(c.conn, head[:]); err != nil {
			return 0, err
		}
		if head[0] != 0x00 {
			return 0, fmt.Errorf("vless bad response version %d", head[0])
		}
		if head[1] > 0 {
			if _, err := io.ReadFull(c.conn, make([]byte, head[1])); err != nil {
				return 0, err
			}
		}
		c.responseRead = true
	}
	return c.conn.Read(b)
}

func (c *vlessConn) Close() error                       { return c.conn.Close() }
func (c *vlessConn) LocalAddr() net.Addr                { return c.conn.LocalAddr() }
func (c *vlessConn) RemoteAddr() net.Addr               { return c.conn.RemoteAddr() }
func (c *vlessConn) SetDeadline(t time.Time) error      { return c.conn.SetDeadline(t) }
func (c *vlessConn) SetReadDeadline(t time.Time) error  { return c.conn.SetReadDeadline(t) }
func (c *vlessConn) SetWriteDeadline(t time.Time) error { return c.conn.SetWriteDeadline(t) }

// ---- xtls-rprx-vision client (padding + XTLS direct) ----------------------

const xrayChunkSize = 8192

var (
	tls13SupportedVersions  = []byte{0x00, 0x2b, 0x00, 0x02, 0x03, 0x04}
	tlsClientHandShakeStart = []byte{0x16, 0x03}
	tlsServerHandShakeStart = []byte{0x16, 0x03, 0x03}
	tlsApplicationDataStart = []byte{0x17, 0x03, 0x03}
)

const (
	commandPaddingContinue byte = iota
	commandPaddingEnd
	commandPaddingDirect
)

var tls13CipherSuiteDic = map[uint16]string{
	0x1301: "TLS_AES_128_GCM_SHA256",
	0x1302: "TLS_AES_256_GCM_SHA384",
	0x1303: "TLS_CHACHA20_POLY1305_SHA256",
	0x1304: "TLS_AES_128_CCM_SHA256",
	0x1305: "TLS_AES_128_CCM_8_SHA256",
}

type visionConn struct {
	net.Conn // the vless logical conn (reads/writes raw TLS stream)

	rawConn net.Conn // underlying TCP conn of the uTLS conn (for XTLS direct)
	input   *bytes.Reader
	rawIn   *bytes.Buffer

	userUUID               [16]byte
	isTLS                  bool
	numberOfPacketToFilter int
	isTLS12orAbove         bool
	remainingServerHello   int32
	cipher                 uint16
	enableXTLS             bool
	isPadding              bool
	directWrite            bool
	writeUUID              bool
	withinPaddingBuffers   bool
	remainingContent       int
	remainingPadding       int
	currentCommand         byte
	directRead             bool
	remainingReader        io.Reader
}

func newVisionConn(vconn *vlessConn, uconn *utls.UConn, uuid [16]byte) (*visionConn, error) {
	// Extract the uTLS conn's internal input/rawInput for XTLS splice.
	connType := reflect.TypeOf(uconn.Conn).Elem()
	inputField, ok1 := connType.FieldByName("input")
	rawInputField, ok2 := connType.FieldByName("rawInput")
	if !ok1 || !ok2 {
		return nil, fmt.Errorf("vision: utls.Conn has no input/rawInput fields")
	}
	connPtr := uintptr(unsafe.Pointer(uconn.Conn))
	return &visionConn{
		Conn:                   vconn,
		rawConn:                uconn.NetConn(),
		input:                  (*bytes.Reader)(unsafe.Pointer(connPtr + inputField.Offset)),
		rawIn:                  (*bytes.Buffer)(unsafe.Pointer(connPtr + rawInputField.Offset)),
		userUUID:               uuid,
		numberOfPacketToFilter: 8,
		remainingServerHello:   -1,
		isPadding:              true,
		writeUUID:              true,
		withinPaddingBuffers:   true,
		remainingContent:       -1,
		remainingPadding:       -1,
	}, nil
}

func (c *visionConn) Read(p []byte) (n int, err error) {
	if c.remainingReader != nil {
		n, err = c.remainingReader.Read(p)
		if err == io.EOF {
			err = nil
			c.remainingReader = nil
		}
		if n > 0 {
			return
		}
	}
	if c.directRead {
		return c.rawConn.Read(p)
	}
	var buffer []byte
	if len(p) > xrayChunkSize {
		n, err = c.Conn.Read(p)
		if err != nil {
			return
		}
		buffer = p[:n]
	} else {
		chunk := make([]byte, xrayChunkSize)
		n, err = c.Conn.Read(chunk)
		if err != nil && n == 0 {
			return 0, err
		}
		buffer = chunk[:n]
	}
	if c.withinPaddingBuffers || c.numberOfPacketToFilter > 0 {
		buffers := c.unPadding(buffer)
		if c.remainingContent == 0 && c.remainingPadding == 0 {
			if c.currentCommand == commandPaddingEnd {
				c.withinPaddingBuffers = false
				c.remainingContent = -1
				c.remainingPadding = -1
			} else if c.currentCommand == commandPaddingDirect {
				c.withinPaddingBuffers = false
				c.directRead = true
				if ib, e := io.ReadAll(c.input); e == nil && len(ib) > 0 {
					buffers = append(buffers, ib)
				}
				if rb, e := io.ReadAll(c.rawIn); e == nil && len(rb) > 0 {
					buffers = append(buffers, rb)
				}
			} else if c.currentCommand == commandPaddingContinue {
				c.withinPaddingBuffers = true
			} else {
				return 0, fmt.Errorf("vision: unknown command %d", c.currentCommand)
			}
		} else if c.remainingContent > 0 || c.remainingPadding > 0 {
			c.withinPaddingBuffers = true
		} else {
			c.withinPaddingBuffers = false
		}
		if c.numberOfPacketToFilter > 0 {
			for _, buf := range buffers {
				c.filterTLS(buf)
			}
		}
		readers := make([]io.Reader, len(buffers))
		for i, b := range buffers {
			readers[i] = bytes.NewReader(b)
		}
		c.remainingReader = io.MultiReader(readers...)
		return c.Read(p)
	}
	if c.numberOfPacketToFilter > 0 {
		c.filterTLS(buffer)
	}
	return n, err
}

func (c *visionConn) Write(p []byte) (n int, err error) {
	if c.numberOfPacketToFilter > 0 {
		c.filterTLS(p)
	}
	if c.isPadding {
		inputLen := len(p)
		buffers := reshapeBuffer(p)
		var specIndex int
		for i, buffer := range buffers {
			if c.isTLS && len(buffer) > 6 && bytes.Equal(tlsApplicationDataStart, buffer[:3]) {
				command := byte(commandPaddingEnd)
				if c.enableXTLS {
					c.directWrite = true
					specIndex = i
					command = commandPaddingDirect
				}
				c.isPadding = false
				buffers[i] = c.padding(buffer, command)
				break
			} else if !c.isTLS12orAbove && c.numberOfPacketToFilter <= 1 {
				c.isPadding = false
				buffers[i] = c.padding(buffer, commandPaddingEnd)
				break
			}
			buffers[i] = c.padding(buffer, commandPaddingContinue)
		}
		if c.directWrite {
			// Write the padded prefix through the vision layer, then switch the
			// rest of the stream to raw TLS-bypass (XTLS splice).
			for i := 0; i <= specIndex; i++ {
				if _, err = c.Conn.Write(buffers[i]); err != nil {
					return
				}
			}
			buffers = buffers[specIndex+1:]
			c.Conn = c.rawConn
			time.Sleep(5 * time.Millisecond)
		}
		for _, buffer := range buffers {
			if _, err = c.Conn.Write(buffer); err != nil {
				return
			}
		}
		n = inputLen
		return
	}
	if c.directWrite {
		return c.rawConn.Write(p)
	}
	return c.Conn.Write(p)
}

func (c *visionConn) filterTLS(buffer []byte) {
	c.numberOfPacketToFilter--
	if len(buffer) > 6 {
		if buffer[0] == 22 && buffer[1] == 3 && buffer[2] == 3 {
			c.isTLS = true
			if buffer[5] == 2 {
				c.isTLS12orAbove = true
				c.remainingServerHello = (int32(buffer[3])<<8 | int32(buffer[4])) + 5
				if len(buffer) >= 79 && c.remainingServerHello >= 79 {
					sessionIDLen := int32(buffer[43])
					cipherSuite := buffer[43+sessionIDLen+1 : 43+sessionIDLen+3]
					c.cipher = uint16(cipherSuite[0])<<8 | uint16(cipherSuite[1])
				}
			}
		} else if bytes.Equal(tlsClientHandShakeStart, buffer[:2]) && buffer[5] == 1 {
			c.isTLS = true
		}
	}
	if c.remainingServerHello > 0 {
		end := int(c.remainingServerHello)
		if end > len(buffer) {
			end = len(buffer)
		}
		c.remainingServerHello -= int32(end)
		if bytes.Contains(buffer[:end], tls13SupportedVersions) {
			cipher, ok := tls13CipherSuiteDic[c.cipher]
			if ok && cipher != "TLS_AES_128_CCM_8_SHA256" {
				c.enableXTLS = true
			}
			c.numberOfPacketToFilter = 0
		} else if c.remainingServerHello == 0 {
			c.numberOfPacketToFilter = 0
		}
	}
}

func (c *visionConn) padding(buffer []byte, command byte) []byte {
	contentLen := len(buffer)
	paddingLen := 0
	if contentLen < 900 && c.isTLS {
		l, _ := rand.Int(rand.Reader, big.NewInt(500))
		paddingLen = int(l.Int64()) + 900 - contentLen
	} else {
		l, _ := rand.Int(rand.Reader, big.NewInt(256))
		paddingLen = int(l.Int64())
	}
	bufferLen := paddingLen + contentLen + 5
	if c.writeUUID {
		bufferLen += 16
	}
	out := make([]byte, 0, bufferLen)
	if c.writeUUID {
		out = append(out, c.userUUID[:]...)
		c.writeUUID = false
	}
	out = append(out, command, byte(contentLen>>8), byte(contentLen), byte(paddingLen>>8), byte(paddingLen))
	out = append(out, buffer...)
	out = append(out, make([]byte, paddingLen)...)
	return out
}

func (c *visionConn) unPadding(buffer []byte) [][]byte {
	var bufferIndex int
	if c.remainingContent == -1 && c.remainingPadding == -1 {
		if len(buffer) >= 21 && bytes.Equal(c.userUUID[:], buffer[:16]) {
			bufferIndex = 16
			c.remainingContent = 0
			c.remainingPadding = 0
			c.currentCommand = 0
		}
	}
	if c.remainingContent == -1 && c.remainingPadding == -1 {
		return [][]byte{buffer}
	}
	var buffers [][]byte
	for bufferIndex < len(buffer) {
		if c.remainingContent <= 0 && c.remainingPadding <= 0 {
			if c.currentCommand == commandPaddingEnd {
				buffers = append(buffers, buffer[bufferIndex:])
				break
			} else {
				if bufferIndex+5 > len(buffer) {
					break
				}
				paddingInfo := buffer[bufferIndex : bufferIndex+5]
				c.currentCommand = paddingInfo[0]
				c.remainingContent = int(paddingInfo[1])<<8 | int(paddingInfo[2])
				c.remainingPadding = int(paddingInfo[3])<<8 | int(paddingInfo[4])
				bufferIndex += 5
			}
		} else if c.remainingContent > 0 {
			end := c.remainingContent
			if end > len(buffer)-bufferIndex {
				end = len(buffer) - bufferIndex
			}
			buffers = append(buffers, buffer[bufferIndex:bufferIndex+end])
			c.remainingContent -= end
			bufferIndex += end
		} else {
			end := c.remainingPadding
			if end > len(buffer)-bufferIndex {
				end = len(buffer) - bufferIndex
			}
			c.remainingPadding -= end
			bufferIndex += end
		}
		if bufferIndex == len(buffer) {
			break
		}
	}
	return buffers
}

func reshapeBuffer(b []byte) [][]byte {
	const bufferLimit = 8192 - 21
	if len(b) < bufferLimit {
		return [][]byte{b}
	}
	index := int(bytes.LastIndex(b, tlsApplicationDataStart))
	if index <= 0 {
		index = 8192 / 2
	}
	return [][]byte{b[:index], b[index:]}
}
