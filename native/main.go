package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
)

// NodeConfig is the subset of a Clash node we need for a native transport.
type NodeConfig struct {
	Type            string `json:"type"`
	Server          string `json:"server"`
	Port            int    `json:"port"`
	Password        string `json:"password"`
	SNI             string `json:"sni"`
	SkipCertVerify  bool   `json:"skip-cert-verify"`
	Ports           string `json:"ports"`
	Obfs            string `json:"obfs"`
	ObfsPassword    string `json:"obfs-password"`
	// vless / reality
	UUID         string `json:"uuid"`
	Flow         string `json:"flow"`
	ServerName   string `json:"servername"`
	PublicKey    string `json:"public-key"`
	ShortID      string `json:"short-id"`
	Fingerprint  string `json:"client-fingerprint"`
}

func main() {
	if len(os.Args) != 5 {
		fmt.Fprintf(os.Stderr, "usage: connector <proto> <node-b64> <host> <port>\n")
		os.Exit(2)
	}
	proto := os.Args[1]
	raw, err := base64.StdEncoding.DecodeString(os.Args[2])
	if err != nil {
		fmt.Fprintf(os.Stderr, "bad node: %v\n", err)
		os.Exit(2)
	}
	var node NodeConfig
	if err := json.Unmarshal(raw, &node); err != nil {
		fmt.Fprintf(os.Stderr, "bad node json: %v\n", err)
		os.Exit(2)
	}
	host := os.Args[3]
	port := os.Args[4]

	conn, err := dial(proto, &node, net.JoinHostPort(host, port))
	if err != nil {
		fmt.Fprintf(os.Stderr, "dial failed: %v\n", err)
		os.Exit(1)
	}
	defer conn.Close()

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, err := io.Copy(conn, os.Stdin)
		if err != nil && err != io.EOF {
			fmt.Fprintf(os.Stderr, "copy stdin->conn: %v\n", err)
		}
		if cw, ok := conn.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		}
	}()
	go func() {
		defer wg.Done()
		_, err := io.Copy(os.Stdout, conn)
		if err != nil && err != io.EOF {
			fmt.Fprintf(os.Stderr, "copy conn->stdout: %v\n", err)
		}
	}()
	wg.Wait()
}
