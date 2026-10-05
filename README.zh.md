# @having5548/dsh-downloader

**境外走代理 · 境内直连 · 自包含** —— 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的下载代理插件。

它给模型注册一个 `dsh_download` 工具：下载文件时**自动判断目标在境内还是境外**，境外走插件自带的代理内核，境内直连，直连失败自动改用代理重试；返回保存路径、字节数、sha256、速度与所用路由。代理出口**不需要本机装 Clash** —— 填一条订阅地址即可，也可以直接指定一个 `proxyUrl`。

---

## ⚠️ 先读这一段：它能覆盖什么，不能覆盖什么

本插件**只管它自己的下载**（即 `dsh_download` 工具）。

| 出网路径 | 是否走本插件 |
|---|---|
| `dsh_download` 工具 | ✅ 走，且按境内外分流 |
| `web_fetch` 工具 | ❌ 不走 |
| shell 里的 `curl` / `git` / `npm` / `Invoke-WebRequest` | ❌ 不走 |
| jobs / workflow / subagent 派生的进程 | ❌ 不走 |
| MCP server 的 HTTP 传输 | ❌ 不走 |

想让**上面这些也走代理**，不需要插件：在 `$DSH_HOME/.env`（Windows 上是 `C:\Users\<你>\.dsh\.env`）里写：

```dotenv
HTTPS_PROXY=http://127.0.0.1:7890
HTTP_PROXY=http://127.0.0.1:7890
NO_PROXY=localhost,127.0.0.1,::1,deepseek.com,.deepseek.com
```

重启 DSH 即可。DSH 会在挂载任何插件之前读取这个文件，把全局 dispatcher、`web_fetch`、以及每个派生子进程一起接管。**只有这个文件能写代理变量**——仓库目录里的 `.env` 写了会被直接拒绝启动。

两者可以同时用，互不干扰：本插件**从不修改 `process.env`，也从不替换全局 dispatcher**。

---

## 安装

```powershell
dsh plugin --profile desktop add @having5548/dsh-downloader
```

或在 DSH 插件市场 / 插件管理器里搜索 `dsh-downloader` 安装。
装完打开 **设置 → 下载代理**。

---

## 配置（设置 → 下载代理）

上游按下面的顺序解析，命中即用：

| 顺序 | 模式 | 条件 |
|---|---|---|
| 1 | `explicit` | 填了 `proxyUrl`（`http://` / `socks5://`） |
| 2 | `environment` | 没填，但 `$HTTPS_PROXY` / `$HTTP_PROXY` 有值（就是上面 `.env` 里那份） |
| 3 | `subscription` | 填了 `subscriptionUrl` —— **自包含，不需要本机 Clash** |
| 4 | `none` | 都没有：境外目标直接报错并给出提示，境内目标仍可直连下载 |

常用字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `proxyUrl` | 空 | 显式上游 |
| `subscriptionUrl` | 空 | Clash 订阅地址（自包含内核从这里取节点） |
| `fetchProxyUrl` | 空 | 只用于抓订阅本身（订阅被墙时填，必须是 `http(s)://`） |
| `autoUpdateHours` | `24` | 订阅自动更新间隔，`0` 关闭 |
| `groupType` | `url-test` | `url-test` 自动最快 / `select` 手动 / `fallback` 失败切换 |
| `preferredNode` | 空 | 按名字固定一个节点 |
| `domesticDirect` | `true` | 关掉则所有下载都走代理 |
| `extraRules` / `excludeRules` | `[]` | 追加 / 剔除规则行 |
| `downloadDir` | 空 | 空 = `$DSH_HOME/downloads` |
| `maxDownloadMb` | `512` | 单文件大小上限 |
| `downloadTimeoutS` | `600` | 单次下载总超时 |
| `stallTimeoutS` | `30` | 无数据停滞多久判定卡死 |
| `insecureTls` | `false` | 跳过 TLS 校验（企业 TLS 解密环境才开） |
| `allowOutsideWorkspace` | `false` | 允许 `save_path` 写到工作区与下载目录之外 |

数据目录：`$DSH_HOME/dsh-downloader/`（订阅缓存 `subscription.yaml`、选中节点 `state.json`）。

---

## 工具

| 工具 | 作用 |
|---|---|
| `dsh_download` | 下载文件。`url` 必填；可选 `save_path` / `overwrite` / `force_route` / `max_mb` / `timeout_seconds`。返回值含 `saved_to`、`bytes`、`sha256`、`speed_bps`、`route`、`route_reason`、`fallback_used`。 |
| `dsh_proxy_status` | 上游模式、订阅状态、节点数与延迟、选中节点、内核端口、最近错误。 |
| `dsh_geo_check` | 判定某个 URL / 主机走直连还是代理。**优先用内置离线规则库（不发任何网络请求）**，只有规则判不出来时才做 DNS + 在线 GeoIP + ping。 |

另注册一个运行时技能 **`smart-download`**：让模型在"下载互联网文件"类任务上优先用 `dsh_download`，而不是 `curl`。

### 路由语义

- **判定是离线的**：内置 11 万条国内域名后缀 + 8.7K 条国内 IP 段，加上订阅自带规则与你的 `extraRules`，按 `DOMAIN` / `DOMAIN-SUFFIX` / `DOMAIN-KEYWORD` / `IP-CIDR` / `REJECT` 匹配。不发网络请求，不怕被墙。
- **loopback 与私有地址永不进代理**（`127.0.0.0/8`、`::1`、`.local`、内网段），即使 `force_route=proxy`。
- 判定为 direct 时**完全不经内核**，直接连；判定为 proxy 时经本地内核 → 节点。
- 直连失败（超时 / DNS / 连接重置）且上游可用时，**自动改用代理重试一次**，返回值里 `fallback_used: true`。

### 完整性语义

- 先写 `<目标>.part`，完成才原子重命名；**任何失败路径都会删掉 `.part`**。
- 边下边算 sha256、边下边卡大小上限、无数据停滞超时检测、全程可被 `exec.signal` 取消。
- 工具的宿主超时被刻意省略（DSH 的 `timeoutMs` 是 opt-in），所以大文件不会被框架掐断，只受 `downloadTimeoutS` 约束。

---

## 节点协议支持

| 协议 | 支持 |
|---|---|
| `socks5` / `http` | ✅ |
| `ss`（aes-128-gcm / aes-256-gcm / chacha20-ietf-poly1305） | ✅ |
| `trojan`（tcp / tls / ws） | ✅ |
| `vless`（tcp / tls / ws） | ✅ |
| `vmess`（AEAD alterId=0，tcp / ws） | ✅ |
| `hysteria2` / `vless reality` | ⚠️ 需要可选的 Go 原生连接器（本包默认不含，Windows amd64）。装法见下。 |
| `tuic` | ❌ |

**启用 hysteria2 / reality**：从 `dsh-clash-proxy` 取 `native/connector.exe`，放进本包的 `lib/native/connector.exe` 即可（`dsh_proxy_status` 会报告 `native connector: present`）。没有它时这些节点会被自动跳过并计数，不影响其他节点。

---

## 与 DSH 内建代理的关系

- 本插件**从不写 `process.env`**，也**从不调 `setGlobalDispatcher`**。因此不存在"卸载后残留"或"和启动器策略互相覆盖"的问题。
- 内核模式下，下载流量是 `node:http` 直连 `127.0.0.1:<本地端口>`，不经过 undici 全局 dispatcher。
- 唯一间接接触：抓订阅用的是自带 HTTP 客户端；若 `fetchProxyUrl` 没填，会退而使用 `$HTTPS_PROXY` / `$HTTP_PROXY`（若它们存在）。

---

## 工作原理

```
模型 → dsh_download
        │
        ├─ 1. 解析上游        explicit / environment / subscription / none
        ├─ 2. 离线规则判定    内置国内域名表 + IP 段 + 订阅规则 + extraRules
        │
        ├─ direct ──────────► 直接连目标
        └─ proxy  ──────────► 127.0.0.1:<随机端口> 本地混合代理
                                   │
                              RuleEngine 决策
                                   ├─ direct → 直连
                                   └─ proxy  → connectThrough(node)
                                                  ss / trojan / vless / vmess /
                                                  socks5 / http / hysteria2

  系统其他程序、DSH 自身的其它出网 ── 完全不受影响
```

内核代码（规则引擎、国内数据、本地混合代理、节点传输、订阅解析）派生自
[`dsh-clash-proxy`](https://github.com/) 0.2.0（MIT），每个文件头部保留出处声明。
本仓库在其上**修复了一个真实的数据截断 bug**：`SocketBuffer.readAny()` 原先在连接关闭时先看
`#ended` 再看缓冲区，导致"已收到但消费者尚未取走"的尾部字节被静默丢弃——实测 512 KiB 的响应
只传出 384 KiB，即静默损坏的下载。详见 `lib/core/transports.js` 的 `[dsh-downloader]` 标记。

---

## 开发

```bash
npm install
node test/smoke.mjs      # 85 项：规则引擎 / 订阅解析 / 路由 / HTTP 客户端 / 端到端下载
npm pack                 # 产出 tgz
```

`test/smoke.mjs` 不需要外网：它起一个本地 HTTP 夹具服务器，并让下载真正穿过插件自己的
`ProxyServer`，逐字节校验 sha256，同时覆盖大小上限、停滞检测、取消、404、重定向与 `.part` 清理。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| 只覆盖本插件的下载 | 见文首的边界表；其它出网路径请用 `$DSH_HOME/.env` |
| `save_path` 的准入检查不等于沙箱 | 写入用的是 `node:fs` 流式写（`ctx.fs` 没有流式写接口），所以是"准入用 DSH 策略、实际写入是宿主写" |
| 缺省文件名按 URL 推断 | `Content-Disposition` 只在返回值里可见；需要精确命名时显式给 `save_path` |
| 无实时进度条 | DSH 工具没有 MCP 那种 `report()` 进度通道；进度只体现在最终返回值的 `bytes` / `speed_bps` |
| `hysteria2` / `reality` 需自带连接器 | 见上 |
| 多实例共用同一数据目录 | 同一 `$DSH_HOME` 下多开 DSH 会共用订阅缓存与选中节点 |

---

## 协议

MIT。内核部分派生自 `dsh-clash-proxy` 0.2.0（MIT），出处见各文件头部与 `LICENSE`。

本插件仅提供技术能力，请确保你的代理服务与使用方式符合当地法律法规。
