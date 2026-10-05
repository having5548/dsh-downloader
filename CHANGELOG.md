# 变更记录

本文件记录 `@having5548/dsh-downloader` 的所有有意义改动。

分类：`新增` / `变更` / `修复` / `兼容` / `移除`。
条目写法遵循「现象 → 根因（具体到代码/契约）→ 修法」，不写"优化了体验"这类空话。

---

## [未发布]

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
