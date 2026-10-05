# native — Go 原生连接器

`lib/native/connector.exe` 的源码。QUIC 传输在 Node 里做不了，所以 hysteria2 与
vless reality 交给这个小程序：通过 stdio 转发字节流（stdin → 远端，远端 → stdout）。

> 改了这里的 `.go` 就必须重新编译并替换 `lib/native/connector.exe`，否则改动不会生效。
> `connector.exe` 是**构建产物**，但为了开箱即用随包发布。

## 支持

| 协议 | 说明 |
| --- | --- |
| `hysteria2` | QUIC + HTTP/3 认证，**含 `salamander` 混淆** |
| `reality` | `vless` + `xtls-rprx-vision` + REALITY |

## 相对上游的改动

派生自 `dsh-clash-proxy` 0.2.0 的 `native/`（MIT），本仓库有两处改动：

1. **`salamander.go`（新增）** —— hysteria2 的 salamander 混淆。
   原版没有它，服务端会**直接丢掉我们的 QUIC 包**，现象是"拨号超时"而不是认证失败。
   线格式：每个 UDP 数据报 = `8 字节随机 salt` ‖ `(明文 ⊕ BLAKE2b-256(password‖salt) keystream)`。
   与 hysteria2 参考实现及 `sagernet/sing-quic/hysteria2` 一致。
2. **`hysteria2.go`** —— 改用 `quic.Transport{Conn: <包装后的 PacketConn>}` + `Transport.Dial()`。
   `quic.DialAddr()` 会自建 socket，混淆没有插进去的位置；连接关闭时一并关闭 transport。
   另外 `NodeConfig` 增加了 `obfs` / `obfs-password`。

## 编译

需要 Go ≥ 1.25（`go.mod` 的要求）。

```bash
# 国内网络：模块走 goproxy.cn
export GOPROXY=https://goproxy.cn,direct
go mod download
go build -trimpath -ldflags "-s -w" -o ../lib/native/connector.exe .
```

PowerShell：

```powershell
$env:GOPROXY='https://goproxy.cn,direct'
go mod download
go build -trimpath -ldflags "-s -w" -o ..\lib\native\connector.exe .
```

产物约 8.7 MB（Windows amd64）。其它平台目前不提供预编译产物：`transports.js`
的 `hasNativeConnector()` 找不到文件时，会把需要连接器的节点计为"不支持"并跳过，
不影响 ss / trojan / vmess / vless(TCP) / socks5 / http 等节点。

## 调用约定

```
connector.exe <proto> <node-json-base64> <host> <port>
```

`<proto>` 是 `hysteria2` 或 `reality`；`<node-json-base64>` 是
`lib/core/transports.js` 里 `nativeConnect()` 组装的那份节点 JSON 的 base64。
失败时进程以非 0 退出，并把原因写到 stderr。
