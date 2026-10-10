# 变更记录

本文件记录 `@having5548/dsh-downloader` 的所有有意义改动。

分类：`新增` / `变更` / `修复` / `兼容` / `移除`。
条目写法遵循「现象 → 根因（具体到代码/契约）→ 修法」，不写"优化了体验"这类空话。

---

## [未发布]

## [0.5.1] - 2026-10-05

### 新增

- **`dsh_download` 支持带鉴权的下载**（GitHub Actions 产物、私有 Release、内部制品库等）。新增两个参数：
  - **`auth`（推荐）** —— 只接受**引用**，token 由插件自己去取，**不进会话记录**：
    - `gh` → 跑 `gh auth token --hostname github.com`，从 GitHub CLI 凭据库读；
    - `env:变量名` → 读环境变量；
    - `bearer:token` → 字面量（会进会话记录，返回值里会带一条提醒）。
  - **`headers`** —— 附加任意请求头；`Host` / `Content-Length` / `Connection` / `Transfer-Encoding` /
    `Proxy-Authorization` / `Proxy-Connection` / `Upgrade` 会被静默忽略，避免调用方把请求弄坏。
- 新增 `lib/download/auth.js`：`resolveAuth()` / `sanitizeHeaders()` / `hasSensitiveHeaders()` / `stripSensitiveHeaders()`。

### 变更

- **跨主机重定向会剥掉 `Authorization` / `Cookie`**。GitHub 的 `archive_download_url` 会 302 到 blob 域，
  把凭据带过去既没用、又等于把 token 交给第三方主机，某些情况下还会被对端 400 拒绝。同主机跳转保持原样。
- 凭据贯穿**每一条**请求：初次探测、`downloadSegmented` 的每一个 Range 分片、以及回退后的
  `attemptSingleStream` 重试。

### 修复

- **分片请求漏传 `headers`**（写这一版时自己踩的）：`trySegmented()` 组装 `downloadSegmented()` 的参数时没带
  `headers`，于是带鉴权的分片下载每一条 Range 都被服务端回 401 → 触发回退单连接（`via_threads: false`，
  结果正确但白白退化成单线程）。已补上，并加了「鉴权 + 分片」的端到端断言钉死它。

> 测试 338 → 360 项：`sanitizeHeaders` 的取舍、`hasSensitiveHeaders` / `stripSensitiveHeaders`、
> `resolveAuth` 的四条成功路径与四条失败路径（`env:` 缺变量 / `env:` 缺名字 / `bearer:` 空值 / 未知引用）、
> 端到端鉴权下载（带头发 200、不带头 401）、**鉴权 + 分片**、以及**同域保留 / 跨域剥离**凭据的重定向断言。

## [0.5.0] - 2026-10-05

### 新增

- **多线程（分片）下载**，参考 gopeed 的 `internal/protocol/http/fetcher.go`。
  新增 `lib/download/segmented.js`：
  - `supportsRanges()` / `parseContentRange()`：从 `accept-ranges` 与 `Content-Range: bytes a-b/total` 判定能否分片；
  - `planChunks()`：按 `threads` 均分起始分片；
  - `stealSlice()`：**工作窃取** —— 从「剩余字节最多的分片」前端切走一半，下限 `STEAL_MIN_BYTES = 512 KiB`，
    低于下限就整块交出。这是 gopeed 相对固定等分的关键差别：固定等分只在各连接速度相当时才快，
    一条慢连接会把整体拖到「最慢分片 × 份数 ÷ 并发」。
  - `downloadSegmented()`：N 个 worker 并发拉取，各自用 `FileHandle.write(buffer, 0, len, offset)` **定位写**同一个文件；
    共享停滞看门狗与取消信号；结束后**按顺序流式算 sha256**（分片乱序落盘，边下边算会得到错误的哈希）。
- 接入 `attemptDownload()`：探测响应的头部满足条件（`threads > 1`、声明大小 ≥ 1 MiB、`accept-ranges: bytes`）时走分片，
  否则原样单连接。**任何分片环节出问题都回退单连接重下**：非 206、缺 `Content-Range`、起点不符、
  合计字节数与声明大小不符 —— 都以 `RangeUnusableError` 收场，绝不拼出坏文件。
  服务器诚实度靠 `If-Range`（etag / last-modified）钉住。
- 配置项 **`threads`**（默认 4，1–32），`dsh_download` 也接受单次调用覆盖；返回值新增 `via_threads` 与 `segments`，
  渲染里会写明「N 个分片并发」还是「单连接（服务端不支持 Range，或已回退）」。
- **侧边栏实时流量徽标**（client slot `sidebar.footer.action`）：不开设置页也能看到经过内核的上下行速率与累计流量。
  展开态两行 `↑ 速率 累计` / `↓ 速率 累计`，56px 收起态切成只显示下行速率的极简排版，两者都带完整 tooltip；
  页面隐藏时降到 5 秒一次；内核没跑时不占地方。

### 变更

- `#trafficSnapshot()` 增加 **1.2 秒采样缓存**。速率是两次采样的差值，而面板 5 秒一轮询、徽标 1.5 秒一轮询，
  不缓存的话两边会互相偷走对方的采样窗口，读数乱跳。返回值新增 `active`（内核是否在跑）。

### 修复

- **`fs.promises.FileHandle.write` 不接受回调**。分片写入最初照 `fs.write` 的写法传了回调，
  该参数被静默忽略、Promise 永不 settle，整个下载挂死（实测：测试套件卡在分片那一步）。
  改为 await Promise 形式并校验 `bytesWritten`。

> 测试 305 → 338 项：`supportsRanges` / `parseContentRange` / `planChunks` / `stealSlice` / `remainingBytes` 的边界，
> 以及端到端的分片下载（3 MiB、sha256 逐字节比对、4 与 8 分片、`threads=1` 走单连接、
> **声称支持 Range 却返回 200 的服务器必须回退且结果仍然正确**、经插件规则内核的分片下载）。
> 测试夹具服务器新增 `/big.bin`（诚实 Range）与 `/liar.bin`（假 Range）两个端点。

## [0.4.0] - 2026-10-05

用户报「`proxyUrl` 填了才有用、`subscriptionUrl` 填了没用而且不能选节点」之后查出来的三件事。他的订阅是
`https://static.mp4dns.online/mp4/…`：**base64 分享链接列表，9 个节点全是 `hysteria2` + `salamander` 混淆**。

### 修复

- **`proxyUrl` 会把订阅整个挤掉**（用户报的"填了没用、没有节点可选"）。
  现象：`proxyUrl` 与 `subscriptionUrl` 都填时，状态显示 `上游模式：explicit`，节点列表里只有一个 `configured-proxy`，
  订阅从未被读取。
  根因：`#rebuild()` 里 `explicit` 分支**先匹配并直接 `return`**，`subscription` 分支根本走不到。
  修法：订阅优先。订阅提供的是**可选节点列表**，`proxyUrl` 只是一条固定上游；现在改为
  `订阅（节点配置 → subscriptionUrl）→ proxyUrl → 环境代理 → none`，`proxyUrl` 退居两用
  （抓订阅时的代理、以及订阅拿不到节点时的兜底），并在 `reason` 里说明为什么退了回退。
- **订阅解析只认 YAML，不认分享链接列表**。
  现象：解析该订阅直接抛「订阅内容既不是 YAML，也不是 base64 包裹的 YAML」。
  根因：`parseSubscription()` 只试「原文 YAML」与「base64 → YAML」两条路，没有「一行一个节点 URI」这条路，
  而这是市面上最常见的订阅格式之一。
  修法：新增 `lib/core/share-links.js`，支持 `hysteria2://`（含 `salamander` 混淆参数）、`ss://`（三种写法）、
  `trojan://`、`vmess://`（base64 JSON）、`vless://`（含 `reality`）、`socks5://`、`http(s)://`，
  明文与 base64 列表都能吃；转成与 Clash YAML 完全等价的节点对象，下游一行未改。
  认不出的行会**计数并在状态里报告**，不再静默丢弃。
- **原生连接器没有把混淆参数传下去**。
  现象：接上连接器后 hysteria2 节点依然连不通（5 秒超时后关闭），且看不出原因。
  根因：`transports.js` 的 `nativeConnect()` 组装 payload 时漏了 `obfs` / `obfs-password`；
  服务端拿不到混淆参数会**直接丢掉我们的 QUIC 包**，表现为"拨号超时"而不是认证失败。
  修法：补上这两个字段；同时给 `salamanderPacketConn` 补 `SetReadBuffer` / `SetWriteBuffer`，
  消除 quic-go 的 "connection doesn't allow setting of receive buffer size" 警告（否则回退到小缓冲区，掉吞吐）。

### 新增

- **自带 Go 原生连接器，hysteria2（含 salamander 混淆）与 vless reality 现在可用**。
  原先 `lib/native/connector.exe` 未打包，`hasNativeConnector()` 恒为 false，这两类节点被静默跳过 ——
  对一份全是 hysteria2 的订阅来说等于"没有可用节点"。
  本版自编译连接器（`-trimpath -ldflags "-s -w"`，8.7 MB），改动：
  - 新增 `native/salamander.go`：salamander 混淆的 `net.PacketConn` 包装。
    线格式：每个数据报 = 8 字节随机 salt ‖ (明文 ⊕ BLAKE2b-256(password‖salt) keystream)。
    与 `sagernet/sing-quic/hysteria2` 及 hysteria2 参考实现一致。
  - `native/hysteria2.go`：改用 `quic.Transport{Conn: 包装后的 PacketConn}` + `Transport.Dial()`，
    因为 `quic.DialAddr()` 会自建 socket，混淆没有插进去的位置；连接关闭时一并关闭 transport。
  - `native/main.go`：`NodeConfig` 增加 `obfs` / `obfs-password`。
  - 编译环境：Go 1.25.14（阿里云镜像）+ `GOPROXY=https://goproxy.cn`。

### 实测（用户的真实订阅）

| 项目 | 结果 |
|---|---|
| 订阅抓取 | 200，2540 字节，`subscription-userinfo` 报告已用 ≈49.7 GB / 300 GB |
| 解析 | 9 个节点全部拿到，`hysteria2`，名字/sni/obfs 齐全 |
| 连通性（经插件 transport） | **9 个里 8 个通**（`HTTP/1.1 204`）；唯一失败的「香港-移动网络专属」名字即说明限移动网络 |
| 对照：不带混淆 | `dial failed: hysteria2 quic dial: timeout` —— 证明混淆是必需的 |

> 测试 255 → 305 项：分享链接七种协议的解析与边界（ss 三种写法、插件 ss 的不支持标记、
> vless reality 缺 pbk 拒绝、无名/无端口拒绝、注释与空行先被过滤、base64 与明文列表、
> `parseSubscription` 的三种 kind 与"认不出仍抛错"）。

## [0.3.1] - 2026-10-05

两处都是**装上真机实测才暴露**的 bug —— 离线单测覆盖不到「与宿主其它工具/服务交互」的那一层。

### 修复

- **`dsh_run_proxied` 委派给 shell 工具时漏传必填的 `description`**。
  现象：`execute=true` 必然失败，报 `invalid arguments: missing required property "description"`。
  根因：`dsh-tool-pwsh` / `dsh-tool-bash` 的 `description` 是**必填**参数，而组装委派参数时只带了 `command`（可选 `workdir`）。
  修法：把组装逻辑抽成纯函数 `buildShellToolArguments()`（可单测）：总是带上 `description`，
  调用方给了就用调用方的，没给就按命令自动生成（`带代理执行：<前 60 字>`）；并给 `dsh_run_proxied` 增加可选的 `description` 参数。
- **挂载 / 重启后第一次调用 `dsh_run_proxied` 报「代理内核还没就绪」**。
  现象：刚装完插件（或刚重启 DSH）立刻调 `dsh_run_proxied` 必定失败；先跑一次 `dsh_proxy_status` 再调就好了。
  根因：内核是懒启动的（第一次 `resolve()` 才监听端口、生成令牌），而工具直接读 `shellProxyEnv()`，此时端口还是 0。
  修法：工具先 `await upstream.resolve()` 再取环境；另外在 `apply()` 末尾**异步预热一次**（不 await，慢订阅不拖挂载），
  让同步的工具守卫也能尽早拿到规则引擎。

### 新增

- `dsh_run_proxied` 新增可选参数 `description`（透传给 shell 工具，写给人看的那句说明）。

> 测试 250 → 255 项，新增 5 条钉住 `buildShellToolArguments()`：一定带 `description`、自动描述含命令、
> 调用方描述优先（并会 trim）、`workdir` 缺省不出现 / 给定时透传。

## [0.3.0] - 2026-10-05

### 新增

- **`git` / `curl` 等 shell 下载也走本插件的代理**（用户要求：凡是需要下载境外内容都走代理插件）。
  背景：`git` / `curl` 跑在 shell 子进程里，工具型插件无法在进程外截获它们，因此做成两条腿。
  - 新增 `lib/core/shell-proxy.js`：
    - `extractHttpUrls()` 从命令里取 http(s) URL；
    - `classifyShellCommand()` 判定这是不是「下载类命令」（`git clone|fetch|pull|submodule`、`curl`、`wget`、`Invoke-WebRequest`），
      并用**离线规则引擎**判断目标是否境外；SSH 远端（`git@host:…`）不判定，因为代理环境变量对它无效；
      命令里已带代理（`HTTP_PROXY` / `curl -x` / `--proxy` / `http.proxy`）时直接放行；
    - `buildProxyUrl()` / `buildShellPrefix()` 生成 `http://dsh:<令牌>@127.0.0.1:<端口>` 与 pwsh / bash 两种前缀；
    - `explainShellRouting()` 生成给模型看的中文说明。
  - 新增工具 **`dsh_run_proxied`**：为**这一次** shell 调用注入代理环境（内核再按规则决定直连还是走节点），
    然后**委派给真正的 shell 工具**（`ctx.tools.execute`）执行 —— 沙箱与权限预设照常生效，不是绕过策略的后门。
    `execute=false` 时只返回拼好的命令。
  - 新增工具守卫 **`guardShellDownloads`**（配置项，默认开）：检测到没带代理的境外 shell 下载时拦下来，
    提示改用 `dsh_run_proxied`（下文件则用 `dsh_download`）。内核没有可用出口时不拦 —— 拦下来却没有替代方案比不拦更糟。
  - `UpstreamManager.shellProxyEnv()` 提供代理 URL 与 `NO_PROXY`；`NO_PROXY` 复用 `composeNoProxy()`，
    即「回环 + 国内 AI 平台域名」，让这些目标连内核都不必经过。
  - 管理面板的规则卡片新增 `guardShellDownloads` 开关。
  - `smart-download` 技能补入这一段工作约定。

### 兼容

- 代理令牌会随 `dsh_run_proxied` 的命令前缀进入该次 shell 调用与会话记录。这是必须的：客户端要拿它通过令牌鉴权。
  它每个 DSH 进程重新生成，且只能访问用户自己的订阅节点。

> 测试 225 → 250 项：URL 提取与去重、境外/境内/回环/内网/SSH/已带代理/REJECT 六类判定、pwsh 与 bash 前缀生成、
> 代理 URL 组成，以及 `dsh_run_proxied` 的两种渲染。

## [0.2.1] - 2026-10-05

### 修复

- **配置列表里非当前那份会打印「? 个节点」**。
  现象：`dsh_profile` 的列表里，未选中的配置显示 `? 个节点`。
  根因：只有当前配置会被真正解析，`renderProfiles` 却对所有条目都输出节点数，取不到就兜底成 `?`。
  修法：只在 `current === true` 且确实有节点数时才输出这一段。
- **有配置时仍重复列出旧版订阅字段**。
  现象：`dsh_proxy_status` 在已导入配置的情况下，仍打印「订阅地址：未填 | proxyUrl：未填 | 启动环境代理：无」，
  而上一行「节点配置」已经说明了实际生效的是什么。
  根因：这两行文案是 0.1.x 时代写的，只在「单条 subscriptionUrl」模型下有意义。
  修法：有配置时只留一行「旧版单条订阅地址：已填（当前不生效，被上面的配置覆盖）/ 未填」；没有配置时才输出完整三字段。

> 本版仅修渲染文案，无功能与行为改动。测试 224 → 225 项。

## [0.2.0] - 2026-10-05

### 新增

- **节点导入对齐 FlClash**（参考 `example/FlClash-main` 的 `Profile` 模型与 `ProfilesAction`）。
  FlClash 把配置存成**一份列表**，每份要么是订阅 URL、要么是导入的本地文件，各自带名字、上次更新时间与自动更新间隔；名字优先取响应头 `Content-Disposition` 的文件名，流量与到期取自 `subscription-userinfo`。本版按同一模型实现：
  - 新增 `lib/core/profiles.js`（`ProfileStore`）：多份配置持久化在 `$DSH_HOME/dsh-downloader/profiles.json`，正文各自放在 `profiles/<id>.yaml`，元数据原子写入。
  - 三种导入入口：订阅地址、`clash://install-config?url=…` 深链（也接受 `clash://<encoded>`）、本地文件正文。`parseImportLink()` 负责把深链还原成地址。
  - `parseSubscriptionUserinfo()` 解析 `upload/download/total/expire`；`Content-Disposition` 起名复用 `filenameFromDisposition()`，无文件名时退回域名（`labelFromUrl()`）。
  - 每份配置独立的自动更新开关与间隔；**本地文件配置永不自动更新**（对应 FlClash 的 `realAutoUpdate`）；到点判断用 `lastUpdateDate + autoUpdateDuration`（`dueProfiles()`），由 5 分钟一次的扫描驱动，而不是全局统一节拍。
  - 操作：选择 / 更新 / 删除 / 改名 / 排序 / 开关自动更新。
  - 新增工具 **`dsh_profile`**（list / add_url / add_file / update / select / remove / auto / reorder / rename），模型可以自己导入订阅。
  - 管理面板新增「节点配置」卡片：配置列表（当前 / 本地文件 / 自动更新 / 流量与到期）、选用 / 更新 / 删除、订阅地址输入框与文件选择器。
  - 旧的单条 `subscriptionUrl` 配置保留为**回退**：只有一份配置都没有时才走它。
- **代理作用域收紧为「只服务 DSH 自己发起的下载」**。
  实现为三重硬约束，并在 `dsh_proxy_status` 的 `scope` 字段与面板上如实报告：
  - 内核只绑 `127.0.0.1`（局域网不可达）；
  - 每次进程启动生成一个 24 字节随机令牌，HTTP 请求必须带 `Proxy-Authorization: Bearer <token>`（也接受 `Basic dsh:<token>`，方便 `curl`），否则回 `407`；
  - 令牌握手装不下，因此**令牌模式下直接拒绝 SOCKS5**（回 `0x05 0xff`），不再对外提供第二个入口。
  令牌不落盘、不写日志、不出现在状态 API 里。
- `fetchSubscription()` 现在同时返回响应头（`{ text, headers, status, url, redirects }`），否则拿不到 `Content-Disposition` 与 `subscription-userinfo`。

### 变更

- `ProxyServer` 构造函数新增 `token` 选项与 `gated` 读取器；`lib/core/proxy-server.js` 的改动处已用 `[dsh-downloader]` 标注。
- `upstream.js` 的 `status()` 新增 `scope` / `profiles` / `profileCount` / `currentProfile` / `activeProfileLabel`。
- 管理面板「上游」卡片新增一句作用域说明。

### 兼容

- 未配置任何「节点配置」的既有安装行为不变，继续使用 `subscriptionUrl`。
- `fetchSubscription()` 的返回值由字符串改为对象（内部 API，仅 `upstream.js` 使用）。

> 测试 171 → 224 项：新增配置存储往返、深链与 userinfo 解析、文件名起名、自动更新到期判定、以及令牌鉴权的三条路径（带令牌成功 / 无令牌 407 / SOCKS5 被拒）。

## [0.1.4] - 2026-10-05

### 修复

- **两处对外文案漏翻，仍在打印原始英文标识符**。
  现象：`dsh_download` 的返回里显示「上游：模式=subscription」，`dsh_session_guard` 的返回里显示「动作：apply」，
  而同一份输出在别处已经渲染成「上游：自包含订阅」。
  根因：0.1.3 新增了 `routeLabel` / `stateLabel` / `modeLabel` 并接到 `renderStatus`，但 `renderDownload`
  的 upstream 一行与 `renderGuard` 的 action 一行直接用了 `shown(value…)`，漏了对应的标签函数。
  修法：`renderDownload` 改用 `modeLabel(value.upstream.mode)`；新增 `actionLabel()` 并让 `renderGuard` 使用。
  冒烟测试补三条断言（下载结果/状态结果/会话保护结果都必须出现本地化标签），合计 171 项。

> 本版仅修文案，无功能与行为改动。

## [0.1.3] - 2026-10-05

### 变更

- **面向模型与用户的文案全部中文化**。
  现象：工具描述、参数说明、工具卡片标题、工具返回的文本、错误提示与运行时技能正文都是英文，用户看不懂。
  根因：初版按"代码注释英文、对外文案随手写"的方式实现，没有区分「开发者日志」与「模型/用户可见文案」。
  修法：
  - 四个工具（`dsh_download` / `dsh_proxy_status` / `dsh_geo_check` / `dsh_session_guard`）的 `description`
    与全部参数 `description` 改中文；
  - `renderDownload` / `renderStatus` / `renderGeo` / `renderGuard` 的输出改中文，并新增
    `routeLabel` / `stateLabel` / `modeLabel`，把 `direct` / `running` / `subscription` 这类标识符
    渲染成「direct（直连）」「运行中」「上游：自包含订阅」；
  - 配置项 `Config` 的 `.description()` 改中文（设置面板与自动表单都会用到）；
  - `route.js` / `fetch-file.js` / `http.js` / `upstream.js` / `session-guard.js` / `subscription.js`
    的错误与状态文案改中文；
  - `smart-download` 运行时技能的 `whenToUse` / `description` / 正文改中文；
  - 管理面板的状态与上游模式徽标改中文（新增 `stRunning` / `mdSubscription` 等词条）。
  - **刻意保持英文的部分**：`ctx.logger` 的开发者日志（便于 grep）、工具返回值的 JSON 键名
    （`saved_to` / `sha256` / `route` 等仍是 API 契约，中英文档都按这些名字说明）、
    以及 vendor 代码（`transports.js` / `vmess.js` / `rules.js`）—— 后者的错误不会直接到达用户，
    `ProxyServer` 只回 502，用户看到的是中文的「代理 CONNECT 被拒绝」。
- 冒烟测试的断言正则同步改为匹配中文消息。

> 本版无功能与行为改动，仅文案语言。

## [0.1.2] - 2026-10-05

### 变更

- **README 结构改为与本项目其它插件一致**：`README.md` 现在是中文主文档、英文移到 `README.en.md`。
  现象：GitHub 仓库首页显示英文，与 `dsh-backup` / `dsh-notify` 的习惯相反。
  根因：初版把英文放在 `README.md`、中文放在 `README.zh.md`。
  修法：两个文件互换角色并统一为居中标题 + shields 徽章 + 三列特性卡的版式；`package.json` 的 `files`
  同步从 `README.zh.md` 改为 `README.en.md`。
- 新增本 `CHANGELOG.md`。

> 本版**无任何运行时代码改动**，下载、路由与会话保护的行为与 0.1.1 完全一致。

## [0.1.1] - 2026-10-05

### 新增

- **内置国内各大 AI 平台域名并强制直连**（22 家，见 `lib/core/ai-domains.js`）。
  需求：代理节点抖动或代理程序关闭时不能断开会话。
  实现：`UpstreamManager#buildEngine()` 把它们转成 `DOMAIN-SUFFIX,<域名>,DIRECT` 并置于 `extraRules` 最前，
  优先级高于订阅自带规则与用户 `extraRules`。
  关键点：`domesticDirect === false`（全部走代理）时不再退化成 `{decide: () => 'proxy'}`，改为
  `[...保护规则, 'MATCH,PROXY']`，保证全代理模式下 AI 域名仍直连。
- 新配置 `protectAiPlatforms`（默认 `true`）与 `extraDirectDomains`（追加强制直连域名，支持完整 URL 与 `*.x.com`）。
- **`dsh_session_guard` 工具**与 `lib/core/session-guard.js`：`check` / `apply` / `restore`，
  修 `$DSH_HOME/.env` 的 `NO_PROXY`。
  背景：本插件是工具型、不碰 LLM 长连接，会话本身受 DSH 启动期全局代理策略支配，需要单独一层来保护。
  安全约束：只在显式 `apply` 时写盘；写前备份为 `<env>.bak-<时间戳>`；**只改 `NO_PROXY` 这一行**，
  绝不动 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`；无变化时不写；`restore` 可还原。
  每个域名同时写 `d` 与 `.d` 两种写法（DSH 匹配裸后缀，老版 curl/git 认前导点），其它行与原有 EOL 原样保留。
- 管理面板新增「会话保护」卡片与 `protectAiPlatforms` / `extraDirectDomains` 字段。
- `dsh_proxy_status` 新增 `ai_protected` / `ai_direct_domain_count` / `ai_direct_domains` / `session_guard`。

### 修复

- **工具返回值与渲染层之间的字段命名不一致**，导致模型看到 `nodes: undefined`、`declared NaN B`。
  根因：服务层用 camelCase（`nodeCount` / `contentLength`），`renderStatus` / `renderDownload` 读 snake_case。
  修法：工具边界统一产出 snake_case（`node_count` / `content_length` / `country_code`…），
  同时让渲染层对缺失/非有限值走 `shown()` 兜底，任何一侧漏掉都不会再打出 `undefined` / `NaN`。
- **`lib/core/transports.js` 的 `SocketBuffer.readAny()` 静默截断数据**。
  现象：经内核下载的 512 KiB 响应只写出 384 KiB，sha256 不匹配 —— 一个静默损坏的下载。
  根因：`readAny()` 先判 `if (this.#ended) return resolve(null)` **再**看缓冲区，于是"已到达但消费者
  （`pumpInto` 等 `drain`）尚未取走"的尾部字节被直接丢弃；小文件因为消费者跟得上而测不出来。
  修法：先排空 `#buffer` 再判 `#ended`，并补上 `#error` 的优先判断；`read()` 同样加 `#error` 检查。
  该文件为 vendor 代码，修改处已用 `[dsh-downloader]` 标注。

### 兼容

- 本版起 `dsh_download` 的错误结果改为 **throw**（而非返回 `ok:false` 的 JSON），使工具错误在会话里
  正确标记为 `isError`；错误信息里附带上游模式与可操作提示。
- 路由理由文案从"规则引擎判定为境内/境外"改为"当前规则把 <host> 指向直连/代理"，以覆盖 AI 保护规则。

## [0.1.0] - 2026-10-05

### 新增

- 首个版本。`dsh_download` / `dsh_proxy_status` / `dsh_geo_check` 三个工具与 `smart-download` 运行时技能。
- 自包含订阅内核：上游按 `proxyUrl` → `$HTTP(S)_PROXY` → `subscriptionUrl` → `none` 依次解析；
  规则引擎 + 国内分流数据（11 万域名后缀 / 8.7K IP 段）+ 本地回环混合代理 + ss / trojan / vless / vmess / socks5 / http 传输。
- 下载语义：`.part` 原子落盘、流式 sha256、大小上限、停滞检测、总超时、取消、重定向跟随、
  直连失败自动回退代理；**任何失败路径都删除半截文件**。
- 刻意省略工具的 `timeoutMs`（DSH 的宿主超时是 opt-in），使大文件不受框架超时约束。
- 「设置 → 下载代理」管理面板：状态 / 订阅更新 / 节点列表 / 逐节点测速 / 组选择 / 实时流量 / 全部配置字段。
- 内核派生自 `dsh-clash-proxy` 0.2.0（MIT），各文件头部保留出处声明。
