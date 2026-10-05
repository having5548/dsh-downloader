package main

import (
	"fmt"
	"net"
)

func dial(proto string, node *NodeConfig, dest string) (net.Conn, error) {
	switch proto {
	case "hysteria2":
		return dialHysteria2(node, dest)
	case "reality":
		return dialReality(node, dest)
	default:
		return nil, fmt.Errorf("unknown proto %q", proto)
	}
}
