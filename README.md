<div align="center">

# ⬇️ dsh-downloader

**DeepSeek Harness 下载代理插件** — 模型下载境外文件时自动走代理、境内直连；代理出口自包含（填一条订阅地址即可，**不需要本机装 Clash**）；并内置国内各大 AI 平台域名强制直连，节点抖动或代理程序关闭都不会断开会话。

简体中文 | [English](README.en.md)

![Version](https://img.shields.io/badge/version-0.5.0-4c7ef3?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078d6?style=flat-square)
![Protocols](https://img.shields.io/badge/nodes-ss%20%7C%20trojan%20%7C%20vless%20%7C%20vmess%20%7C%20socks5%20%7C%20http-2b6cb0?style=flat-square)
![Tests](https://img.shields.io/badge/tests-338%20passed-2fa95e?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

</div>

---

## ✨ 特性

| | | |
|---|---|---|
| 🌏 **境外走代理、境内直连**<br>`dsh_download` 一次调用内完成判定与下载，不用模型自己挑路线 | 📦 **代理出口自包含**<br>一条订阅即可用，**不依赖本机 Clash**；YAML 与分享链接两种订阅格式都吃，ss / trojan / vless / vmess / hysteria2（含 salamander 混淆）/ socks5 / http | 🛡️ **会话保活**<br>内置 22 家国内 AI 平台域名强制直连，优先级高于一切规则；另有 `dsh_session_guard` 守住 `$DSH_HOME/.env` |
| ⚡ **大文件多线程**<br>服务端支持 `Range` 时自动分片并发；先完成的连接去偷剩余最多的分片，慢服务器拖不住整体 | 📊 **侧边栏实时流量**<br>不开设置页也能看到经过内核的上下行速率与累计流量 | 🧮 **离线分流判定**<br>内置 11 万条国内域名后缀 + 8.7K 条国内 IP 段，**判定不发任何网络请求**，不怕被墙 | 🔁 **失败自动回退**<br>直连失败（超时 / DNS / 连接重置）自动改用代理重试一次，结果里如实标 `fallback_used` | 🔐 **完整性可验证**<br>边下边算 sha256，返回保存路径、字节数、实时速度与所用路由 |
| 🧯 **失败不留残骸**<br>先写 `.part` 再原子重命名；**任何失败路径都删掉半截文件**，重跑永远安全 | ⏱️ **大文件不被打断**<br>刻意不声明宿主工具超时，只受自己可配的 `downloadTimeoutS` 与停滞检测约束 | 🖥️ **设置页管理面板**<br>状态 / 配置导入与管理 / 节点列表 / 逐节点测速 / 选组 / 实时流量 / 全部配置项 | 🗂️ **节点配置对齐 FlClash**<br>多份配置（订阅 URL / clash:// 深链 / 本地文件），各自的名字、上次更新时间与自动更新间隔 | 🔒 **只服务 DSH 自己发起的下载**<br>内核只绑回环 + 每进程随机令牌，其它程序连不上也借不走；系统代理与环境变量从未被改动 |

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
dsh plugin --profile desktop add https://github.com/having5548/dsh-downloader/releases/latest/download/having5548-dsh-downloader-0.5.0.tgz
```

本地打包安装：

```bash
npm pack
dsh plugin --profile desktop add having5548-dsh-downloader-0.5.0.tgz
```

> profile 名：新版桌面端是 `desktop`，旧版 Web 端是 `web`。

装完打开 **设置 → 下载代理**。

## 🚀 快速开始

1. 打开 **设置 → 下载代理**。
2. 在**「节点配置」**卡片里导入节点 —— 对齐 FlClash 的三种方式：
   - **从订阅地址导入**：粘贴 `https://…`，或直接粘 FlClash / Clash Verge 那种 `clash://install-config?url=…` 深链（会自动取出里面的地址）。
   - **从文件导入**：选一个本地 `.yaml` / `.yml` 配置文件。
   - **名称留空**时按 FlClash 的规则自动取名：先取响应头 `Content-Disposition` 里的文件名，再退回域名。
   每份配置独立保存，带自己的**上次更新时间**与**自动更新开关/间隔**（默认 24 小时；本地文件配置不自动更新，与 FlClash 一致）。
3. 点「选用」切换当前配置、「更新」重新拉取、「删除」移除。
4. 也可以完全不动手，直接让模型用 `dsh_profile` 工具导入，例如：

   > 把这个订阅导入：https://example.com/api/v1/client/subscribe?token=xxx

5. 让模型下载一个境外文件，例如：

   > 下载 https://github.com/X/Y/releases/latest/download/app.zip 到 D:\dl

6. 结果里看 `route`：`proxy` = 走了节点，`direct` = 境内直连，`fallback_used: true` = 直连失败后回退到代理。

> 旧版的单条 `subscriptionUrl` 配置依然可用：只有在**没有任何配置**时才会走它；一旦导入过配置，就以选中的那份为准。

## ⚡ 多线程下载

服务端支持 `Range` 时，大文件会自动分成 `threads`（默认 4）个连接并发下载。

**关键不是"切成 N 份"，而是怎么切。** 固定等分只在各家网速相当时才快 —— 一条慢连接会拖住整体（`总时间 = 最慢那份的时间 × 份数` 除以并发）。所以这里照搬 gopeed 的做法（`internal/protocol/http/fetcher.go`）：

- 起始按 `threads` 均分；
- **谁先下完，谁就去偷「剩余字节最多的那个分片」的前半段**（下限 512 KiB，太碎就不值得单开请求）；
- 于是慢分片会被不断切走，快的连接一直满载，直到全部抢完。

| 情况 | 行为 |
| --- | --- |
| 服务端没有 `accept-ranges: bytes` | 单连接 |
| 文件 < 1 MiB | 单连接（协调开销大于收益） |
| `threads` = 1 | 单连接 |
| 服务端**嘴上支持 Range 却返回 200** | 检测到后**回退单连接重下**，绝不拼出坏文件 |
| `Content-Range` 起点不符 / 合计字节数不符 | 同上，回退重下 |

分片各写同一文件的对应偏移（`FileHandle.write` 定位写），完成后按顺序流式算 sha256 —— 因为分片是乱序落盘的，边下边算会得到错误的哈希。

返回值里的 `via_threads` 与 `segments` 说明实际走了哪条路；面板的「下载」卡片可以调 `threads`。

## 📊 侧边栏实时流量

侧边栏页脚（设置图标旁）有一个流量徽标，实时显示经过本插件内核的上下行速率与累计流量：

```
↑ 1.2 MB/s   340 KB
↓ 3.4 MB/s   1.8 GB
```

- 数据来自内核的字节计数器（`/traffic`），**只统计经过本插件的流量**，不是全机网卡流量。
- 侧边栏收起成 56px 窄条时自动切成极简排版，只显示下行速率。
- 速率是两次采样之间的差值，所以内核侧加了 1.2 秒的采样缓存 —— 否则面板（5 秒一次）与徽标（1.5 秒一次）会互相偷走对方的采样窗口，读数乱跳。
- 页面切到后台时降到 5 秒一次。
- 内核没在跑时徽标不占地方。


## 🔒 代理作用域：只服务 DSH 自己发起的下载

代理**只**服务本插件发起的下载请求。这不是靠约定，而是三重硬约束：

| 约束 | 效果 |
|---|---|
| **只绑 `127.0.0.1`** | 局域网内其它机器根本连不上这个监听 |
| **每进程随机令牌** | 与下载客户端在进程内一起生成，从不落盘、从不写日志。没有令牌的连接一律 `407`；SOCKS5 因为握手带不了令牌，直接被拒 |
| **不碰系统代理、不写环境变量** | 浏览器、其它 App、以及 DSH 里非本插件的出网请求，全部保持原样 |

`dsh_proxy_status` 的返回里有 `scope` 字段如实报告这三条；面板的「上游」卡片也会写出来。

**换句话说**：就算这个端口被人扫到，他也用不了；而除 `dsh_download` 以外的任何流量，从来没有经过这个插件。

## 🧩 git / curl 下载境外内容：也走这个代理

`git` / `curl` 跑在 shell 子进程里，工具型插件无法在进程外截获它们。所以这里做成**两条腿**：

**① 给模型一条带上代理的命令**（`dsh_run_proxied`）：

```
dsh_run_proxied({ command: "git clone https://github.com/x/y.git" })
```

它会为**这一次** shell 调用注入代理环境（`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 及小写形式，指向本插件内核），
然后交给**正常的 shell 工具**执行 —— 沙箱与权限策略照常生效，不是另开一条后门。
国内目标仍由内核判定直连；国内 AI 平台域名写进 `NO_PROXY`，连内核都不经过。

`execute=false` 时它只返回拼好的命令，你或模型自己用 pwsh 跑也行。

**② 一条工具守卫**（`guardShellDownloads`，默认开）：

当 shell 命令看起来要从境外下载、又没带代理时（`git clone|fetch|pull|submodule`、`curl`、`wget`、
`Invoke-WebRequest` 且目标经离线规则判定为境外），命令会被**拦下来**，并提示改用 `dsh_run_proxied` 或 `dsh_download`。

不会被拦的情况：命令里已经带了代理（`HTTP_PROXY`、`curl -x`、`git -c http.proxy`）；目标是回环/内网；
内核没有可用出口（拦下来却没有替代方案比不拦更糟）；SSH 形式（`git@github.com:…` 不走 HTTP，代理环境变量对它无效）。

嫌它碍事可以在设置里关掉。

**只是要下一个文件时，优先 `dsh_download`** —— 它带 sha256、大小上限、停滞检测与失败回退。
`dsh_run_proxied` 是给"必须用 git/curl 本身"的场景（克隆仓库、调用 API）准备的。

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
| 1 | `subscription` | 有「节点配置」或填了 `subscriptionUrl` —— **自包含，不需要本机 Clash**，并且能选节点 |
| 2 | `explicit` | 填了 `proxyUrl`（`http://` / `socks5://`），或订阅拿不到节点时的兜底 |
| 3 | `environment` | 都没填，但 `$HTTPS_PROXY` / `$HTTP_PROXY` 有值（就是 `.env` 里那份） |
| 4 | `none` | 都没有：境外目标直接报错并给出可操作提示，境内目标仍可直连下载 |

> **为什么订阅优先**：订阅给的是一份**可选节点的列表**，`proxyUrl` 只是一条固定上游。两者都填时若让 `proxyUrl` 赢，就会出现"填了订阅却没反应、也没有节点可选"——这是 v0.3.1 及以前的实际行为，v0.4.0 起修正。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `proxyUrl` | 空 | 一条固定上游；**两种情况下才生效**：抓订阅时当代理用、以及订阅拿不到节点时兜底 |
| `subscriptionUrl` | 空 | 单条订阅地址（同「节点配置」的导入源）；**优先级高于 `proxyUrl`** |
| `fetchProxyUrl` | 空 | 只用于抓订阅本身（订阅被墙时填，必须是 `http(s)://`） |
| `autoUpdateHours` | `24` | 旧版单条订阅的自动更新间隔，也是新导入配置的默认间隔；`0` 关闭 |
| `groupType` | `url-test` | `url-test` 自动最快 / `select` 手动 / `fallback` 失败切换 |
| `preferredNode` | 空 | 按名字固定一个节点 |
| `latencyTestUrl` / `latencyTimeoutMs` | gstatic 204 / `3000` | 节点健康检查 URL 与超时 |
| `domesticDirect` | `true` | 关掉则所有下载都走代理（**AI 平台仍直连**） |
| `protectAiPlatforms` | `true` | 国内 AI 平台域名强制直连，最高优先级 |
| `extraDirectDomains` | `[]` | 追加强制直连的域名（支持完整 URL 与 `*.x.com`） |
| `guardShellDownloads` | `true` | 拦住没走代理的境外 shell 下载，提示改用 `dsh_run_proxied` |
| `extraRules` / `excludeRules` | `[]` | 追加 / 剔除规则行 |
| `downloadDir` | 空 | 空 = `$DSH_HOME/downloads` |
| `maxDownloadMb` | `512` | 单文件大小上限 |
| `downloadTimeoutS` | `600` | 单次下载总超时 |
| `stallTimeoutS` | `30` | 无数据停滞多久判定卡死 |
| `threads` | `4` | 多线程下载的分片连接数；`1` = 单连接。服务端不支持 `Range`、响应不可信、或文件 < 1 MiB 时自动回退单连接 |
| `insecureTls` | `false` | 跳过 TLS 校验（企业 TLS 解密环境才开） |
| `allowOutsideWorkspace` | `false` | 允许 `save_path` 写到工作区与下载目录之外 |
| `maxRedirects` | `10` | 重定向上限 |

数据目录：`$DSH_HOME/dsh-downloader/` —— `profiles.json`（配置清单）+ `profiles/<id>.yaml`（每份配置正文），以及旧版单条订阅的 `subscription.yaml` 缓存与选中节点的 `state.json`。

## 🧰 工具

| 工具 | 作用 |
|---|---|
| `dsh_download` | 下载文件。`url` 必填；可选 `save_path` / `overwrite` / `force_route` / `max_mb` / `timeout_seconds`。返回 `saved_to`、`bytes`、`sha256`、`speed_bps`、`route`、`route_reason`、`fallback_used`。 |
| `dsh_proxy_status` | 上游模式、订阅状态、节点数与延迟、选中节点、内核端口、AI 保护状态、会话守卫状态、最近错误。 |
| `dsh_geo_check` | 判定某个 URL / 主机走直连还是代理。**优先用内置离线规则库（不发任何网络请求）**，只有规则判不出来时才做 DNS + 在线 GeoIP + ping。 |
| `dsh_session_guard` | 检查 / 写入 / 还原 `$DSH_HOME/.env` 的 `NO_PROXY`（见上文「会话保护」）。 |
| `dsh_profile` | 管理节点配置（FlClash 式）：列出 / 从订阅地址或 `clash://` 深链导入 / 从配置正文导入 / 更新 / 选择 / 删除 / 开关自动更新 / 排序 / 改名。 |
| `dsh_run_proxied` | 让 `git` / `curl` 这类 shell 下载走本插件的代理（只作用于这一次调用，仍走正常 shell 工具与权限策略）。 |

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
| `hysteria2`（含 `salamander` 混淆） | ✅ 自带 Go 原生连接器（Windows amd64，已打包） |
| `vless reality` | ✅ 同上 |
| `tuic` | ❌ |

**原生连接器已内置**：`lib/native/connector.exe`（自编译，含 hysteria2 的 salamander 混淆与 vless reality）。`dsh_proxy_status` 会报告 `原生连接器：已内置`。非 Windows-amd64 平台上这些节点会被自动跳过并计数，不影响其他节点。

## 📥 支持哪些订阅格式

| 格式 | 说明 |
|---|---|
| Clash / mihomo YAML | `proxies` + `proxy-groups` + `rules`，完整支持 |
| **base64 包裹的 YAML** | 常见于 `?flag=clash` 之类的接口 |
| **分享链接列表**（base64 或明文） | 一行一个 `hysteria2://` / `ss://` / `trojan://` / `vmess://` / `vless://` / `socks5://` / `http(s)://`，最常见的机场格式之一 |

分享链接会被转成与 Clash YAML 完全等价的节点对象，下游（规则引擎、传输层）一行都不用改。认不出的行会**计数并报告**（`订阅已加载 9 个节点（跳过 2 条）`），而不是静默丢弃。

> 带插件的 `ss`（`?plugin=…`）与 `tuic` 会被明确列为「不支持」，不会假装加载成功。


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
node test/smoke.mjs      # 338 项：规则引擎 / 订阅解析 / 配置导入 / 路由 / HTTP 客户端 / 端到端下载 / 会话守卫 / 令牌鉴权
node --check lib/client.js
npm pack
```

`test/smoke.mjs` **不需要外网**：它起一个本地 HTTP 夹具服务器，并让下载真正穿过插件自己的 `ProxyServer`，逐字节校验 sha256，同时覆盖大小上限、停滞检测、取消、404、重定向、`.part` 清理，以及"AI 域名在最严格规则下仍直连""没有令牌的连接被拒 407""apply 绝不新增代理变量"这类断言。

## ⚠️ 已知限制

| 限制 | 说明 |
|---|---|
| 只覆盖本插件的下载 | 见文首的边界表；其它出网路径请用 `$DSH_HOME/.env` |
| `save_path` 的准入检查不等于沙箱 | 写入用的是 `node:fs` 流式写（`ctx.fs` 没有流式写接口），所以是"准入用 DSH 策略、实际写入是宿主写" |
| 缺省文件名按 URL 推断 | `Content-Disposition` 只在返回值里可见；需要精确命名时显式给 `save_path` |
| 无实时进度条 | DSH 工具没有 MCP 那种 `report()` 进度通道；进度只体现在最终返回值的 `bytes` / `speed_bps` |
| 原生连接器仅 Windows amd64 | `lib/native/connector.exe` 是 Windows amd64 二进制；其它平台会跳过 hysteria2 / reality 节点并计数 |
| 多实例共用同一数据目录 | 同一 `$DSH_HOME` 下多开 DSH 会共用配置清单、订阅缓存与选中节点 |
| 令牌模式下不接受 SOCKS5 入站 | SOCKS5 握手装不下令牌，所以该协议被直接拒绝；本插件自身走 HTTP CONNECT，不受影响 |
| 会话保护会写工作区外的文件 | 只在**显式**调 `dsh_session_guard action="apply"`（或点面板按钮）时写 `$DSH_HOME/.env`：写前自动备份、可 `restore`，且只改 `NO_PROXY` 这一行 |

## 📄 License

MIT。内核部分派生自 `dsh-clash-proxy` 0.2.0（MIT），出处见各文件头部与 [LICENSE](LICENSE)。

本插件仅提供技术能力，请确保你的代理服务与使用方式符合当地法律法规。
