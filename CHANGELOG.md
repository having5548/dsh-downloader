# 变更记录

本文件记录 `@having5548/dsh-downloader` 的所有有意义改动。

分类：`新增` / `变更` / `修复` / `兼容` / `移除`。
条目写法遵循「现象 → 根因（具体到代码/契约）→ 修法」，不写"优化了体验"这类空话。

---

## [未发布]

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
