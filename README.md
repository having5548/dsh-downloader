<div align="center">

# ⬇️ dsh-downloader

**DeepSeek Harness 下载代理插件** — 模型下载境外文件时自动走代理、境内直连；代理出口自包含（填一条订阅地址即可，**不需要本机装 Clash**）；并内置国内各大 AI 平台域名强制直连，节点抖动或代理程序关闭都不会断开会话。

简体中文 | [English](README.en.md)

![Version](https://img.shields.io/badge/version-0.1.2-4c7ef3?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078d6?style=flat-square)
![Protocols](https://img.shields.io/badge/nodes-ss%20%7C%20trojan%20%7C%20vless%20%7C%20vmess%20%7C%20socks5%20%7C%20http-2b6cb0?style=flat-square)
![Tests](https://img.shields.io/badge/tests-168%20passed-2fa95e?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

</div>

---

## ✨ 特性

| | | |
|---|---|---|
| 🌏 **境外走代理、境内直连**<br>`dsh_download` 一次调用内完成判定与下载，不用模型自己挑路线 | 📦 **代理出口自包含**<br>填一条 Clash 订阅地址即可用；ss / trojan / vless / vmess / socks5 / http，**不依赖本机 Clash** | 🛡️ **会话保活**<br>内置 22 家国内 AI 平台域名强制直连，优先级高于一切规则；另有 `dsh_session_guard` 守住 `$DSH_HOME/.env` |
| 🧮 **离线分流判定**<br>内置 11 万条国内域名后缀 + 8.7K 条国内 IP 段，**判定不发任何网络请求**，不怕被墙 | 🔁 **失败自动回退**<br>直连失败（超时 / DNS / 连接重置）自动改用代理重试一次，结果里如实标 `fallback_used` | 🔐 **完整性可验证**<br>边下边算 sha256，返回保存路径、字节数、实时速度与所用路由 |
| 🧯 **失败不留残骸**<br>先写 `.part` 再原子重命名；**任何失败路径都删掉半截文件**，重跑永远安全 | ⏱️ **大文件不被打断**<br>刻意不声明宿主工具超时，只受自己可配的 `downloadTimeoutS` 与停滞检测约束 | 🖥️ **设置页管理面板**<br>状态 / 订阅更新 / 节点列表 / 逐节点测速 / 选组 / 实时流量 / 全部配置项 |

## ⚠️ 先读这一段：它能覆盖什么

本插件是**工具型** —— 它只管 `dsh_download` 自己的下载。

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

重启 DSH 即可 —— DSH 在挂载任何插件之前就会读这个文件，把全局 dispatcher、`web_fetch` 以及每个派生子进程一起接管。**只有这个文件能写代理变量**；仓库目录里的 `.env` 写了会被直接拒绝启动。

两者可以同时用、互不干扰：本插件**从不修改 `process.env`，也从不替换全局 dispatcher**。

## 📦 安装

从 GitHub Release 安装：

```bash
dsh plugin --profile desktop add https://github.com/having5548/dsh-downloader/releases/latest/download/having5548-dsh-downloader-0.1.2.tgz
```

本地打包安装：

```bash
npm pack
dsh plugin --profile desktop add having5548-dsh-downloader-0.1.2.tgz
```

> profile 名：新版桌面端是 `desktop`，旧版 Web 端是 `web`。

装完打开 **设置 → 下载代理**。

## 🚀 快速开始

1. 打开 **设置 → 下载代理**。
2. 上游二选一：
   - **自包含（推荐）**：填 `subscriptionUrl`（Clash 订阅地址）→ 点「更新订阅」→ 节点列表出现 → 点「全部测速」挑个快的。
   - **走已有代理**：填 `proxyUrl`，如 `http://127.0.0.1:7890` 或 `socks5://127.0.0.1:1080`。
3. 让模型下载一个境外文件，例如：

   > 下载 https://github.com/X/Y/releases/latest/download/app.zip 到 D:\dl

4. 结果里看 `route`：`proxy` = 走了节点，`direct` = 境内直连，`fallback_used: true` = 直连失败后回退到代理。

## 🛡️ 会话保护：国内 AI 平台强制直连

代理节点一抖，走代理的长连接就会断；而这个 Harness 自己的模型接口**全都是国内服务**，本来就不该走代理。这件事需要两层 —— 因为工具型插件碰不到 LLM 长连接。

### 第一层：下载路径（插件内核，默认开）

内置下列平台的域名，转成 `DOMAIN-SUFFIX,<域名>,DIRECT` 并**置于最高优先级** —— 高于订阅自带规则、高于你写的 `extraRules`，**连 `domesticDirect=false`（全部走代理）模式下也照样直连**：

> DeepSeek · 智谱/Z.ai/ChatGLM · 月之暗面 Kimi · 阿里通义/DashScope · 字节豆包/火山方舟 · 百度文心/千帆 · 腾讯混元 · 讯飞星火 · MiniMax · 零一万物 · 阶跃星辰 · 商汤日日新 · 百川智能 · 硅基流动 · 昆仑万维天工 · 华为云盘古/ModelArts · 网易有道 · 澜舟 · 元象 · 面壁 · 出门问问 · 国家超算/启智

清单见 [`lib/core/ai-domains.js`](lib/core/ai-domains.js)。表里不存在的条目最多只是不匹配，没有副作用；用 `extraDirectDomains` 可以继续加自己的域名或完整 URL。

### 第二层：Harness 自身的模型连接（点一下）

真正决定模型流量走哪的是 DSH 启动期的全局代理策略（`$DSH_HOME/.env` 里的 `HTTP_PROXY` / `HTTPS_PROXY`）。代理程序一关，走它的连接就全断 —— 会话当场终止。

用 `dsh_session_guard` 工具（或设置页里的「会话保护」卡片）修：

| 动作 | 效果 |
|---|---|
| `check`（默认） | 只读：报告该文件有没有代理变量、AI 域名在 `NO_PROXY` 里的覆盖情况与缺口 |
| `apply` | 把缺失域名合并进 `NO_PROXY`。**写之前自动备份**；**只改 `NO_PROXY` 这一行**，绝不动 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`；无变化时不写 |
| `restore` | 用最新备份还原；没有备份就明确报错 |

每个域名同时写 `d` 与 `.d` 两种写法（DSH 匹配裸后缀，老版 curl/git 认前导点），其它行与原有换行符原样保留。

> `apply` 之后**需要重启 DSH** —— 那个文件是启动期读一次的，工具返回值里也带这条提醒。

## ⚙️ 配置

上游按下面的顺序解析，命中即用：

| 顺序 | 模式 | 条件 |
|---|---|---|
| 1 | `explicit` | 填了 `proxyUrl`（`http://` / `socks5://`） |
| 2 | `environment` | 没填，但 `$HTTPS_PROXY` / `$HTTP_PROXY` 有值（就是 `.env` 里那份） |
| 3 | `subscription` | 填了 `subscriptionUrl` —— **自包含，不需要本机 Clash** |
| 4 | `none` | 都没有：境外目标直接报错并给出可操作提示，境内目标仍可直连下载 |

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `proxyUrl` | 空 | 显式上游 |
| `subscriptionUrl` | 空 | Clash 订阅地址（自包含内核从这里取节点） |
| `fetchProxyUrl` | 空 | 只用于抓订阅本身（订阅被墙时填，必须是 `http(s)://`） |
| `autoUpdateHours` | `24` | 订阅自动更新间隔，`0` 关闭 |
| `groupType` | `url-test` | `url-test` 自动最快 / `select` 手动 / `fallback` 失败切换 |
| `preferredNode` | 空 | 按名字固定一个节点 |
| `latencyTestUrl` / `latencyTimeoutMs` | gstatic 204 / `3000` | 节点健康检查 URL 与超时 |
| `domesticDirect` | `true` | 关掉则所有下载都走代理（**AI 平台仍直连**） |
| `protectAiPlatforms` | `true` | 国内 AI 平台域名强制直连，最高优先级 |
| `extraDirectDomains` | `[]` | 追加强制直连的域名（支持完整 URL 与 `*.x.com`） |
| `extraRules` / `excludeRules` | `[]` | 追加 / 剔除规则行 |
| `downloadDir` | 空 | 空 = `$DSH_HOME/downloads` |
| `maxDownloadMb` | `512` | 单文件大小上限 |
| `downloadTimeoutS` | `600` | 单次下载总超时 |
| `stallTimeoutS` | `30` | 无数据停滞多久判定卡死 |
| `insecureTls` | `false` | 跳过 TLS 校验（企业 TLS 解密环境才开） |
| `allowOutsideWorkspace` | `false` | 允许 `save_path` 写到工作区与下载目录之外 |
| `maxRedirects` | `10` | 重定向上限 |

数据目录：`$DSH_HOME/dsh-downloader/`（订阅缓存 `subscription.yaml`、选中节点 `state.json`）。

## 🧰 工具

| 工具 | 作用 |
|---|---|
| `dsh_download` | 下载文件。`url` 必填；可选 `save_path` / `overwrite` / `force_route` / `max_mb` / `timeout_seconds`。返回 `saved_to`、`bytes`、`sha256`、`speed_bps`、`route`、`route_reason`、`fallback_used`。 |
| `dsh_proxy_status` | 上游模式、订阅状态、节点数与延迟、选中节点、内核端口、AI 保护状态、会话守卫状态、最近错误。 |
| `dsh_geo_check` | 判定某个 URL / 主机走直连还是代理。**优先用内置离线规则库（不发任何网络请求）**，只有规则判不出来时才做 DNS + 在线 GeoIP + ping。 |
| `dsh_session_guard` | 检查 / 写入 / 还原 `$DSH_HOME/.env` 的 `NO_PROXY`（见上文「会话保护」）。 |

另注册一个运行时技能 **`smart-download`**：让模型在"下载互联网文件"类任务上优先用 `dsh_download`，而不是 `curl`。

### 路由语义

- **判定是离线的**：内置 11 万条国内域名后缀 + 8.7K 条国内 IP 段，加上订阅自带规则与你的 `extraRules`，按 `DOMAIN` / `DOMAIN-SUFFIX` / `DOMAIN-KEYWORD` / `IP-CIDR` / `REJECT` 匹配。不发网络请求，不怕被墙。
- **国内 AI 平台域名永远直连**：以最高优先级插在所有规则之前，用户规则也覆盖不掉（除非关掉 `protectAiPlatforms`）。
- **loopback 与私有地址永不进代理**（`127.0.0.0/8`、`::1`、`.local`、内网段），即使 `force_route=proxy`。
- 判定为 `direct` 时**完全不经内核**，直接连；判定为 `proxy` 时经本地内核 → 节点。
- 直连失败且上游可用时，**自动改用代理重试一次**，返回值里 `fallback_used: true`。

### 完整性语义

- 先写 `<目标>.part`，完成才原子重命名；**任何失败路径都会删掉 `.part`**。
- 边下边算 sha256、边下边卡大小上限、无数据停滞超时检测、全程可被 `exec.signal` 取消。
- 工具的宿主超时被刻意省略（DSH 的 `timeoutMs` 是 opt-in），所以大文件不会被框架掐断，只受 `downloadTimeoutS` 约束。

## 🌐 节点协议支持

| 协议 | 支持 |
|---|---|
| `socks5` / `http` | ✅ |
| `ss`（aes-128-gcm / aes-256-gcm / chacha20-ietf-poly1305） | ✅ |
| `trojan`（tcp / tls / ws） | ✅ |
| `vless`（tcp / tls / ws） | ✅ |
| `vmess`（AEAD alterId=0，tcp / ws） | ✅ |
| `hysteria2` / `vless reality` | ⚠️ 需要可选的 Go 原生连接器（本包默认不含，Windows amd64） |
| `tuic` | ❌ |

**启用 hysteria2 / reality**：从 `dsh-clash-proxy` 取 `native/connector.exe`，放进本包的 `lib/native/connector.exe` 即可（`dsh_proxy_status` 会报告 `native connector: present`）。没有它时这些节点会被自动跳过并计数，不影响其他节点。

## 🔗 与 DSH 内建代理的关系

- 本插件**从不写 `process.env`**，也**从不调 `setGlobalDispatcher`**，所以不存在"卸载后残留"或"和启动器策略互相覆盖"的问题。
- 内核模式下，下载流量是 `node:http` 直连 `127.0.0.1:<本地端口>`，不经过 undici 全局 dispatcher。
- 唯一间接接触：抓订阅用的是自带 HTTP 客户端；若 `fetchProxyUrl` 没填，会退而使用 `$HTTPS_PROXY` / `$HTTP_PROXY`（若它们存在）。

## 🔧 工作原理

```
模型 → dsh_download
        │
        ├─ 1. 解析上游        explicit / environment / subscription / none
        ├─ 2. 离线规则判定    内置国内域名表 + IP 段 + AI 平台保护 + 订阅规则 + extraRules
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

内核代码（规则引擎、国内分流数据、本地混合代理、节点传输、订阅解析）派生自 `dsh-clash-proxy` 0.2.0（MIT），每个文件头部保留出处声明。本仓库在其之上**修复了一个真实的数据截断 bug**：`SocketBuffer.readAny()` 原先在连接关闭时先看 `#ended` 再看缓冲区，导致"已收到但消费者尚未取走"的尾部字节被静默丢弃 —— 实测 512 KiB 的响应只传出 384 KiB，即静默损坏的下载。详见 `lib/core/transports.js` 的 `[dsh-downloader]` 标记。

## 🧪 开发与测试

```bash
npm install
node test/smoke.mjs      # 168 项：规则引擎 / 订阅解析 / 路由 / HTTP 客户端 / 端到端下载 / 会话守卫
node --check lib/client.js
npm pack
```

`test/smoke.mjs` **不需要外网**：它起一个本地 HTTP 夹具服务器，并让下载真正穿过插件自己的 `ProxyServer`，逐字节校验 sha256，同时覆盖大小上限、停滞检测、取消、404、重定向、`.part` 清理，以及"AI 域名在最严格规则下仍直连"与"apply 绝不新增代理变量"这类断言。

## ⚠️ 已知限制

| 限制 | 说明 |
|---|---|
| 只覆盖本插件的下载 | 见文首的边界表；其它出网路径请用 `$DSH_HOME/.env` |
| `save_path` 的准入检查不等于沙箱 | 写入用的是 `node:fs` 流式写（`ctx.fs` 没有流式写接口），所以是"准入用 DSH 策略、实际写入是宿主写" |
| 缺省文件名按 URL 推断 | `Content-Disposition` 只在返回值里可见；需要精确命名时显式给 `save_path` |
| 无实时进度条 | DSH 工具没有 MCP 那种 `report()` 进度通道；进度只体现在最终返回值的 `bytes` / `speed_bps` |
| `hysteria2` / `reality` 需自带连接器 | 见上 |
| 多实例共用同一数据目录 | 同一 `$DSH_HOME` 下多开 DSH 会共用订阅缓存与选中节点 |
| 会话保护会写工作区外的文件 | 只在**显式**调 `dsh_session_guard action="apply"`（或点面板按钮）时写 `$DSH_HOME/.env`：写前自动备份、可 `restore`，且只改 `NO_PROXY` 这一行 |

## 📄 License

MIT。内核部分派生自 `dsh-clash-proxy` 0.2.0（MIT），出处见各文件头部与 [LICENSE](LICENSE)。

本插件仅提供技术能力，请确保你的代理服务与使用方式符合当地法律法规。
