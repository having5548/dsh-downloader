# dsh-downloader —— 详细设计文档

> 状态：设计待评审 · 目标运行时：DSH `0.2.0-rc.2`（Windows / Electron 打包版）
> 参考实现：[`plugins/clash-downloader`](../plugins/clash-downloader/)、[`example/dsh-clash`](../example/dsh-clash/)
> 本文档中所有"已核实"结论都来自对 `resources/app.asar` 内实际运行时代码的阅读，附录 A 给出出处。

---

## 0. 一句话定位

**一个 DSH 插件，注册"下载"类工具，让模型下载境外文件时自动走代理，境内直连，代理出口由插件自带的订阅内核提供——不依赖本机任何 Clash/mihomo 程序，也不改动 DSH 的全局网络策略。**

形态决策（已确认）：

| 决策点 | 选择 |
|---|---|
| 形态 | **C. 工具型** —— 注册工具 + 技能，模型主动调用；**不做**全局接管 |
| 上游 | **自包含订阅内核** 优先；**配置项 / 环境变量显式指定** 为轻量模式 |
| 不采用 | 探测本机 Clash（ZCode 插件那套）、修改 `process.env`、替换全局 dispatcher |

---

## 1. 目标与非目标

### 1.1 目标

| # | 目标 | 验收方式 |
|---|---|---|
| G1 | 模型能用 `dsh_download` 把境外文件下到磁盘 | 真实 GitHub Release 下载成功，返回 `saved_to` / `sha256` / `bytes` / `speed` |
| G2 | 路由自动判定：境外走节点、境内直连、失败自动回退 | 日志与返回值里的 `route` / `route_reason`；两条链路各跑一次 |
| G3 | 代理出口自包含：仅凭一条订阅 URL 即可工作 | 在**没有** FlClash / mihomo 的机器上完成 G1 |
| G4 | 零全局副作用 | 插件加载前后 `process.env` 中 `HTTP(S)_PROXY` 完全一致；pwsh 里 `curl` 仍直连；卸载后无监听端口残留 |
| G5 | 大文件可控 | `.part` 临时文件、大小上限、停滞检测、总超时、重定向上限、可取消（`exec.signal`） |
| G6 | 模型知道该用哪个工具、什么时候用 | 注册 runtime skill，`whenToUse` 命中"下载文件/安装包/模型/数据集" |

### 1.2 非目标（本期明确不做）

| 不做 | 原因 |
|---|---|
| 修改 `process.env` 让全进程树走代理 | 那是"接管型"；本次选 C。**副作用是 `web_fetch` / `curl` / `git` / `npm` 不走本插件**，见 §11.1 |
| 替换 undici 全局 dispatcher | 同上；且会与启动器的策略互相覆盖 |
| 提供 SOCKS5 **入站**服务给外部程序用 | 工具型不需要；如需，是可选扩展（§12 扩展位） |
| 系统代理 / TUN 设置 | 安全边界，永不触碰 |
| 修改 Windows 注册表 | 同上 |
| 探测本机 Clash 端口 | 已确认走自包含路线 |

---

## 2. 为什么是"工具型 + 自包含订阅"

### 2.1 两个参考插件各贡献一半

| 来源 | 拿什么 | 丢掉什么 |
|---|---|---|
| `plugins/clash-downloader`（ZCode） | **工具语义层**：`geo_check` 判定、`download_file` 的 `.part`/sha256/进度/大小上限/停滞检测/直连失败回退/重定向；`SKILL.md` 的工作约定文案 | MCP 协议外壳、`protect_api`（工具型不需要）、`import_subscription` 的 `clash://` 深链 |
| `example/dsh-clash`（DSH） | **网络内核**：订阅抓取与解析、规则引擎 + 国内域名/IP 数据、本地混合代理服务、节点传输（ss/trojan/vless/vmess/hysteria2）、测速 | `inject.js`（env + dispatcher 接管）、`manager.js`（生命周期编排，需重写）、`lib/index.js`（**用的是 0.1.x 的 settings API，在 0.2.0-rc.2 上会直接 import 失败**）、客户端半部 |

### 2.2 为什么"自包含订阅"要和"本地代理服务"配对

真实的订阅节点是 `ss` / `trojan` / `vless` / `vmess` / `hysteria2` —— 它们**不是 HTTP 代理**，`http.request({proxy})` 用不了，undici 的 `ProxyAgent` 也用不了。

两条路：
- **(a) 复用 `example/dsh-clash` 的 `ProxyServer`**：起一个 `127.0.0.1:<随机端口>` 的混合代理（HTTP CONNECT + SOCKS5），它按规则引擎决策后调 `connectThrough(node, ...)`。下载器只要对着这个本地端口发标准 `CONNECT` 即可——**这正是 clash-downloader 已有的代码路径**。
- (b) 让下载器直接 dial 节点，自己搭 TLS 之上的 HTTP 客户端（需要把 `{read: AsyncIterable, write, close}` 的 face 桥接成 `net.Socket` 形状喂给 `tls.connect`）。

**选 (a)**：改动最小、两个半边都已经有测试、规则决策与节点选择集中在一处。代价是插件加载期间多一个回环监听（绑 `127.0.0.1` 随机端口，卸载即关）。

### 2.3 相对原版的一处主动改进：分流用**离线规则引擎**而不是 GeoIP

clash-downloader 的分流靠 `analyzeTarget()` → DNS 解析 → 调 `ip-api.com` 查 GeoIP。这有三个问题：要联网、有速率限制、被墙时判定不出来。

我们**已经有了离线数据**：`example/dsh-clash` 内置 11 万条国内域名后缀（压缩后 467KB）与 8.7K 条国内 IP 段。因此：

- **主判定**：`RuleEngine.decide(host)`（离线，零延迟，零外部依赖）
- **辅助判定**：仅当域名无命中且目标是字面 IP 时，才用 `cn-cidrs` 数据
- **在线 GeoIP**：只在 `dsh_geo_check` 这个**诊断工具**里用，不参与下载路径

### 2.4 会话保活：国内 AI 平台强制直连（两层）

节点一抖，走代理的长连接就断；而本 Harness 用的模型接口全是国内服务，本来就不该走代理。这需要**两层**，因为工具型插件的边界决定了它管不到会话本身：

**第一层 —— 下载路径（插件内核，默认开）。** `lib/core/ai-domains.js` 内置 DeepSeek / 智谱 Z.ai / Kimi / 通义 DashScope / 豆包火山方舟 / 文心千帆 / 腾讯混元 / 讯飞星火 / MiniMax / 零一万物 / 阶跃 / 商汤 / 百川 / 硅基流动 / 天工 / 华为盘古 / 有道 / 澜舟 / 元象 / 面壁 / 出门问问 / 超算 等域名，在 `#buildEngine()` 里转成 `DOMAIN-SUFFIX,<域名>,DIRECT` 并**置于 `extraRules` 最前**；`domesticDirect === false` 时也不再退化成 `{decide: () => 'proxy'}`，而是 `[...protected, 'MATCH,PROXY']`，**保证全代理模式下 AI 域名仍直连**。用户规则排在保护之后，因此覆盖不掉（除非关 `protectAiPlatforms`）。

**第二层 —— Harness 自身连接（用户显式触发）。** 工具型插件**从不碰 LLM 长连接**，所以第一层保护不到会话。真正决定模型流量去向的是 DSH 启动期读的 `$DSH_HOME/.env`（T1/T2）。`lib/core/session-guard.js` 提供 `inspectGuard` / `applyGuard` / `restoreGuard`：

| 动作 | 行为 |
|---|---|
| `check` | 只读；报告该文件是否存在、有哪些代理变量、AI 域名在 `NO_PROXY` 里的覆盖情况与缺口 |
| `apply` | 把缺失域名合并进 `NO_PROXY`（每个域名同时写 `d` 与 `.d` 两种写法：DSH 匹配裸后缀，老版 curl/git 认前导点）。**先备份**为 `<env>.bak-<时间戳>`；**只改 `NO_PROXY` 这一行**，绝不动 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`；无变化时不写 |
| `restore` | 用最新备份覆盖回去；没有备份就明确报错 |

`upsertNoProxy()` 保留其它行与原有 EOL（CRLF/LF），重复的 `no_proxy` 键只留一个。因为启动器只在启动期读一次，`apply` 之后**必须重启 DSH**，工具输出里会带这条提醒。

---

## 3. 已核实的运行时事实（0.2.0-rc.2）

这一节是设计的地基，全部来自实际代码。**其中 T3 / T4 直接推翻了 `example/dsh-clash` 的两处写法。**

| # | 事实 | 影响 |
|---|---|---|
| **T1** | DSH 启动器在**挂载任何插件之前**调用 `installProxyFromEnvironment(launchEnv)`，从 process env + `$DSH_HOME/.env` 解析代理策略，装 undici 全局 dispatcher | 全局代理是"启动期一次性"的，插件改不动也不该改；也说明**零代码方案存在**（见 §3.1） |
| **T2** | 只有 `$DSH_HOME/.env`（`C:\Users\a2736\.dsh\.env`）允许写 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`；**仓库目录里的 `.env` 写了会抛错拒绝启动** | 明确"用户的文件"与"随 clone 到来的文件"的信任边界 |
| **T3** | `@deepseek-ai/dsh-settings@0.2.0-rc.2` 的导出只有 `SettingsConflictError` / `SettingsForms` / `redactSecrets`——**没有 `installSettingsSection`，也没有 `settingsNamespace`** | `example/dsh-clash/lib/index.js` 第 2 行的 import 在当前运行时**必然失败**。设置必须改用 0.2.0 的方式：模块导出 `Config` schema + `.volatile()` 标记可编辑字段 + 客户端 `ctx.get('configForms').get(entryId)` |
| **T4** | 工具超时是**显式 opt-in**：`dsh-tool-call-timeout-policy` 读 `ctx.tools.get(name).timeoutMs`，**为 `undefined` 时直接 `next()`，不设任何超时** | 下载工具**不声明 `timeoutMs`**，自然获得无限预算；超时由插件自己的 deadline + 停滞检测 + `exec.signal` 负责 |
| **T5** | 工具契约（`ToolDefinition`）要求：`name` / `description` / `parameters`(JSON Schema Record) / `output.schema` / `output.render` / `execute`；可选 `presentCall` / `presentResult` / `isConcurrencySafe` / `timeoutMs`；保留名 `run_code` | 见 §7 |
| **T6** | 技能注册：`ctx.skills.register({ name, description, content, ... })`；`validateRuntimeSkill` 只校验 `name`（kebab-case 正则）/ `description` 非空 / `invocation`，但下游 `runtimeCandidate` 会把 `source` 当字符串用 | **必须显式传 `source`**，否则运行时报 "non-string source" |
| **T7** | 客户端设置面板模板（`dsh-notify` 是能跑的 0.2.0 插件）：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section', id, order, label, locale, inject }, Component))`；配置读写走惰性 `ctx.get('configForms').get(entryId)`，且 `subscribe`/`getSnapshot` 是**类原型方法，必须 bind 或包闭包** | 见 §9 |
| **T8** | `cordis.patch.yml` 模板：`- insert: [{ id: <entryId>, name: '<pkg>', inject: [...] }]`；`entryId` 同时是 `configForms.get()` 的 key | 见 §4.2 |
| **T9** | `@deepseek-ai/dsh-http-proxy` / `dsh-settings` / `dsh-tools` / `dsh-skill` / `schemastery` 都在 `desktop-runtime.json` 的 287 个 `sharedPackages` 里；`undici` **不在** | 依赖声明策略见 §4.2 |
| **T10** | **当前机器没有可用代理**：`$DSH_HOME/.env` 不存在；FlClash 只有 `FlClashHelperService` 在跑（占 47890，实测不是可用 HTTP 代理，返回 500）；7890 无监听；系统代理 `ProxyEnable=0` | 开发期必须依赖自包含内核或本地测试夹具，不能指望"本机有 Clash" |

## 3.1 与 DSH 内建代理的关系（重要，写进 README）

用户如果只想要"**所有** DSH 出网（含 `web_fetch`、`curl`、`git`、`npm`、jobs、subagent）都走代理"，**不需要任何插件**，只需：

```dotenv
# C:\Users\a2736\.dsh\.env   ← 唯一允许写代理变量的位置
HTTPS_PROXY=http://127.0.0.1:7890
HTTP_PROXY=http://127.0.0.1:7890
NO_PROXY=localhost,127.0.0.1,::1,deepseek.com,.deepseek.com,z.ai,.z.ai,bigmodel.cn,.bigmodel.cn
```

重启 DSH 生效。已核实 DSH 会：把全局 undici dispatcher 指向它、让 `dsh-web-fetch-http` 走 `proxyRouteFor(url)`、并在 `scrubbedParentEnv()` 里给**每个派生子进程**叠加代理变量与 `NODE_USE_ENV_PROXY=1`。

**本插件的价值不是"能不能走代理"，而是三件 DSH 做不到的事**：

1. **按目标分流**（DSH 只有 `NO_PROXY` 这一个全局开关，表达不了"国内直连 / 国外走代理"）；
2. **不需要本机有 Clash**（自包含订阅内核）；
3. **模型主导的、带完整性校验的下载**（sha256、大小上限、停滞检测、失败回退）。

两者可共存，且互不干扰（见 §11.2）。

---

## 4. 架构

### 4.1 模块图

```
┌───────────────────────── DSH Host 进程 ─────────────────────────┐
│                                                                  │
│  lib/index.js  ── apply(ctx, config)                            │
│    ├─ Config (schemastery, 模块导出)  ← Loader 校验 / 设置表单     │
│    ├─ ctx.tools.register × 3         ← dsh_download / status / geo│
│    ├─ ctx.skills.register × 1        ← smart-download            │
│    └─ 惰性 ctx.inject(['webServer']) ← /dsh-downloader/* JSON API │
│                                                                  │
│  lib/core/upstream.js   ← 上游解析与降级（lightweight ⇄ kernel）   │
│    ├─ lightweight: 直接用 config.proxyUrl / $HTTPS_PROXY          │
│    └─ kernel:      SubscriptionStore + RuleEngine + ProxyServer   │
│                                                                  │
│  lib/core/subscription.js   (vendored) 抓取 / 解析 / 缓存 / 自动更新 │
│  lib/core/rules.js          (vendored) RuleEngine + cn-*.json.gz   │
│  lib/core/proxy-server.js   (vendored) 127.0.0.1:<随机> 混合代理    │
│  lib/core/transports.js     (vendored) connectThrough / measureLatency │
│  lib/core/{vmess,ws}.js     (vendored)                             │
│  lib/native/connector.exe   (vendored, 可选) hysteria2 / reality    │
│                                                                  │
│  lib/download/http.js   ← openTarget / httpFlow（HTTP 客户端）      │
│  lib/download/fetch-file.js ← 流式落盘 + sha256 + 上限 + 停滞检测   │
│  lib/download/route.js  ← 路由决策（离线规则优先）                  │
└──────────────────────────────────────────────────────────────────┘
                             ▲
                             │ 标准 HTTP CONNECT
                             │ http://127.0.0.1:<port>
                             ▼
                  （kernel 模式下的本地混合代理）
                             │
                  ┌──────────┴──────────┐
                  ▼                     ▼
             国内目标直连          connectThrough(node,…)
                                      ▼
                              ss / trojan / vless / vmess /
                              hysteria2 / socks5 / http
```

### 4.2 目录结构与元数据

```
H:\mycode\dsh-downloader\
├─ package.json
├─ cordis.patch.yml
├─ README.md  README.zh.md
├─ LICENSE                       (MIT)
├─ DESIGN.md                     (本文档)
├─ lib\
│  ├─ index.js                   Host 半部：Config / tools / skills / webServer
│  ├─ client.js                  客户端半部：设置面板（M3）
│  ├─ core\                      ← vendored from example/dsh-clash（MIT，保留出处注释）
│  │  ├─ subscription.js  rules.js  proxy-server.js  transports.js  vmess.js  ws.js
│  │  └─ data\ cn-domains.json.gz  cn-cidrs.json.gz  cn-cidrs6.json.gz
│  ├─ native\connector.exe       ← 可选（见下）
│  └─ download\ http.js  fetch-file.js  route.js
├─ native\                       ← connector.exe 的 Go 源码（可重建，保留）
└─ test\ smoke.mjs  proxy-e2e.mjs  fixtures.mjs
```

**`package.json` 关键字段**（照 `dsh-notify` 这个能跑的 0.2.0 插件抄）：

```jsonc
{
  "name": "@having5548/dsh-downloader",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".":         { "default": "./lib/index.js" },
    "./client":  { "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib", "native", "cordis.patch.yml", "README.md", "README.zh.md", "LICENSE"],
  "engines": { "node": ">=20" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-runtime",
                 "@deepseek-ai/dsh-client-locale",
                 "@deepseek-ai/dsh-client-ui-settings"]
    }
  },
  "dependencies": { "schemastery": "^3.18.0", "js-yaml": "^4.1.0" },
  "peerDependencies": {
    "@deepseek-ai/dsh-client-runtime": "*",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "peerDependenciesMeta": { /* 三个都 optional: true，照 dsh-notify */ }
}
```

> **依赖策略**：`schemastery` 与 `js-yaml` 走真实 `dependencies`（`dsh-notify` 就是这么做的，profile 装包时会带上）；`@deepseek-ai/*` 运行期服务不写进 dependencies——它们是 `desktop-runtime.json` 的 sharedPackages，由宿主提供（T9）。**不要**依赖 `undici`（不在 sharedPackages，且本设计完全用 `node:http`/`node:tls`）。

**`cordis.patch.yml`**：

```yaml
# dsh-downloader bundle patch。
# 单条双面行：node 半边提供下载工具与订阅内核，client 半边（见 package.json）
# 把管理面板挂进 settings.section。不发布跨会话服务，无需 isolate realm。
# timer 服务提供订阅自动更新与节点测速循环。
- insert:
    - id: dsh-downloader
      name: '@having5548/dsh-downloader'
      inject: [timer]
```

> `id` 必须与客户端 `ctx.get('configForms').get('dsh-downloader')` 的 key 一致（T8）。

**关于 `connector.exe`（12MB）**：只在需要 `hysteria2` / `vless-reality` 时才需要，且是 Windows amd64 专用。建议**默认不打包**（包体从 ~13MB 降到 ~600KB），把 `native/` Go 源码与构建说明留在仓库里作为可选步骤；`Config.supportedOptionalProtocols` 里如实报告"未内置连接器，这两类节点跳过"。

---

## 5. 数据流

### 5.1 插件挂载（`apply`）

```
Loader 挂载 dsh-downloader
  ├─ Config(config ?? {})               // schemastery 填默认值，得到不可变初值
  ├─ current = () => initial            // 配置取值闭包，设置表单变更后指向新源
  ├─ ctx.tools.register(dsh_download)   // 返回 disposer，交给 ctx.effect 管理
  ├─ ctx.tools.register(dsh_proxy_status)
  ├─ ctx.tools.register(dsh_geo_check)
  ├─ ctx.skills.register({ name:'smart-download', source:'dsh-downloader', … })
  ├─ ctx.inject(['webServer'], …)       // 惰性：headless profile 里没有也不卡挂载
  │    └─ webServer.register({ kind:'prefix', path:'/dsh-downloader', handler })
  ├─ upstream = new UpstreamManager(ctx, current)   // 懒启动，第一次调用才解析
  └─ ctx.on('dispose', () => upstream.stop())       // 关监听、清定时器、清缓存
```

**关键：`apply` 必须同步快速返回。** 订阅抓取 / 节点测速一律异步懒启动，否则一个慢订阅会把整个 profile 挂载卡住（`example/dsh-clash` 的 `manager.start()` 就是 `void` 掉异步的）。

### 5.2 一次 `dsh_download` 调用

```
execute(args, exec)
 1. 校验：url 必填、协议必须是 http/https；save_path 解析（见 §11.3）
 2. 存在性检查：目标存在且 !overwrite → 抛错（提示 overwrite 或换路径）
 3. exec.signal.throwIfAborted()
 4. 解析上游：upstream.resolve()            → { mode, proxy: {host,port} | null, reason }
 5. 路由决策 route.decide(url, upstream)    → { route: 'proxy'|'direct', reason }
      ├─ force_route 显式覆盖
      ├─ 无上游可用 && 判定为 proxy → 抛错并给可操作提示
      └─ 判定 uncertain → 先 TCP 探测，可达则直连
 6. httpFlow(url, { proxy, timeoutMs, signal, maxRedirects })
      └─ 抛错且 route==='direct' && 上游可用 → 自动改走 proxy 重试一次
 7. 流式落盘：写 `<target>.part` → sha256 → 大小上限 → 停滞检测 → 总 deadline
 8. 成功：close → rename(.part → target) → 返回结构化结果
    失败：删除 .part，抛错（保留原始 message 与 httpStatus）
```

返回值（`output.schema` 的形状）：

```jsonc
{
  "ok": true,
  "saved_to": "D:\\downloads\\app.zip",
  "bytes": 73400320,
  "sha256": "…",
  "speed_bps": 5242880,
  "elapsed_ms": 14000,
  "route": "proxy",                    // proxy | direct
  "route_reason": "规则命中 DOMAIN-SUFFIX,github.com,PROXY",
  "upstream": { "mode": "kernel", "node": "🇯🇵 JP-01", "type": "trojan" },
  "http": { "status": 200, "redirects": 2, "content_length": 73400320 },
  "warnings": []
}
```

### 5.3 上游解析与降级（`upstream.resolve()`）

按顺序尝试，命中即用；**任何一步失败都只降级、不抛错**（除非最终没有任何可用出口且路由判定为 proxy）：

| 顺序 | 模式 | 条件 | 行为 |
|---|---|---|---|
| 1 | `explicit` | `config.proxyUrl` 非空 | 直接用；不发订阅请求、不起内核 |
| 2 | `env` | `$HTTPS_PROXY` / `$HTTP_PROXY` 非空 | 同上（这是 DSH 启动策略发布进 `process.env` 的值） |
| 3 | `kernel` | `config.subscriptionUrl` 非空（或 `$DSH_DOWNLOADER_SUBSCRIPTION`） | 抓订阅 → 解析 → 建 RuleEngine → 起本地 `ProxyServer` → 节点可用性/延迟探测 |
| 4 | `none` | 以上皆无 | `mode:'none'`；境外目标直接报错并给出可操作提示；境内目标仍可直连下载 |

**模式 1/2 与 3 的取舍**：模式 1/2 下没有规则引擎，路由判定退化为"全部直连"或"全部走代理"（由 `force_route` 决定），并在返回值 `warnings` 里说明。模式 3 才有真正的境内外分流。

**订阅缓存在 `$DSH_HOME/dsh-downloader/`**：`subscription.yaml` + `subscription.meta.json`（`{at,url}`）+ `state.json`（手动选中的节点名）。离线可用；`autoUpdateHours` 由 `ctx.setInterval` 驱动（`inject: ['timer']`）。

---

## 6. Config Schema

用 `schemastery`（与 `dsh-notify` 一致），**每个希望出现在设置表单里的字段都要 `.volatile()`**（0.2.0 的 `SettingsForms` 只投影 volatile 字段，T3）。

| 字段 | 类型 | 默认 | volatile | 说明 |
|---|---|---|---|---|
| `enabled` | boolean | `true` | ✅ | 总开关；关闭时下载工具直接报错，不解析上游 |
| `proxyUrl` | string | `""` | ✅ | 显式上游，`http://host:port` 或 `socks5://host:port`。非空即启用 `explicit` 模式 |
| `subscriptionUrl` | string `.role('secret')` | `""` | ✅ | Clash 订阅地址；也可用 `$DSH_DOWNLOADER_SUBSCRIPTION` |
| `fetchProxyUrl` | string `.role('secret')` | `""` | ✅ | 抓订阅本身用的代理（订阅被墙时填） |
| `autoUpdateHours` | number(step 1, min 0) | `24` | ✅ | 订阅自动更新间隔，`0` 关闭 |
| `groupType` | union `url-test`\|`select`\|`fallback` | `url-test` | ✅ | 节点组类型 |
| `preferredNode` | string | `""` | ✅ | 手动指定节点名（优先级高于 `groupType`） |
| `latencyTestUrl` | string | `http://www.gstatic.com/generate_204` | ✅ | 节点健康检查 URL |
| `latencyTimeoutMs` | number(step 100, min 500, max 10000) | `3000` | ✅ | 单节点测速超时 |
| `domesticDirect` | boolean | `true` | ✅ | 关掉则所有下载都走代理（AI 平台仍直连） |
| `protectAiPlatforms` | boolean | `true` | ✅ | 国内 AI 平台域名强制直连，最高优先级（见 §2.4） |
| `extraDirectDomains` | string[] | `[]` | ✅ | 追加强制直连的域名（支持完整 URL / `*.x.com`） |
| `extraRules` | string[] | `[]` | ✅ | 追加规则，如 `DOMAIN-SUFFIX,example.com,DIRECT` |
| `excludeRules` | string[] | `[]` | ✅ | 从订阅规则中剔除（子串匹配） |
| `domesticCountries` | string[] | `["CN"]` | ✅ | 在线 GeoIP 工具用的直连国家码白名单 |
| `downloadDir` | string | `""` | ✅ | 默认下载目录；空 = `$DSH_HOME/downloads` |
| `maxDownloadMb` | number(min 1) | `512` | ✅ | 单文件大小上限 |
| `downloadTimeoutS` | number(min 1) | `600` | ✅ | 单次下载总超时 |
| `stallTimeoutS` | number(min 5) | `30` | ✅ | 无数据停滞多久判定卡死 |
| `insecureTls` | boolean | `false` | ✅ | 跳过 TLS 校验（默认关；企业 TLS 解密环境才开） |
| `allowOutsideWorkspace` | boolean | `false` | ✅ | 是否允许写到工作区之外（见 §11.3） |
| `maxRedirects` | number(min 0, max 30) | `10` | ✅ | 重定向上限 |

> **不 volatile 的字段**：无。若将来需要"只能改配置文件、不进 GUI"的字段（如调试开关），保持不加 `.volatile()` 即可。

---

## 7. 工具契约

三个工具统一约定：

- `isConcurrencySafe: () => true`（下载之间互不依赖；同名目标由 `.part` 与 rename 前的二次存在性检查兜底）
- **不声明 `timeoutMs`**（T4：不声明 = 无宿主超时），超时全部由 `downloadTimeoutS` + `stallTimeoutS` + `exec.signal` 负责
- `output.schema` 用 `{ type:'object', additionalProperties:true }` 一类的宽松 JSON Schema，`output.render` 负责产出**模型实际看到的文本**

### 7.1 `dsh_download`

```
name: dsh_download
description: 下载一个文件到本地磁盘。自动判断目标在境内还是境外：境外走插件内置的代理，
             境内直连；直连失败会自动改用代理重试。返回保存路径、字节数、sha256 与所用路由。
parameters:
  url            string  (required)   http/https 下载地址
  save_path      string  (optional)   目标路径或目录；目录时按 URL 自动取文件名
  overwrite      boolean (default false)
  force_route    enum auto|proxy|direct (default auto)
  max_mb         number  (optional)   覆盖 config.maxDownloadMb
  timeout_seconds number (optional)   覆盖 config.downloadTimeoutS
```

### 7.2 `dsh_proxy_status`

```
name: dsh_proxy_status
description: 报告下载代理的当前状态：上游模式、订阅是否已加载、节点数与延迟、当前选中节点、
             规则数量、本地代理端口。用于排查"下载为什么走/不走代理"。
parameters:
  refresh  boolean (default false)   是否强制重新探测（重抓订阅、重测延迟）
  test_all boolean (default false)   是否顺带对全部节点测速
```

### 7.3 `dsh_geo_check`

```
name: dsh_geo_check
description: 判断一个 URL 或主机名在境内还是境外，给出分流建议。优先用内置离线规则库
             （不发任何网络请求）；无命中时才做 DNS + 在线 GeoIP，并附带 ICMP/TCP 探测。
parameters:
  url_or_host  string  (required)
  ping         boolean (default true)
```

> 命名取舍：不带前缀的 `download_file` 更符合模型直觉，但全局工具名可能与其他插件撞车。这里统一加 `dsh_` 前缀；如果评审时认为可读性更重要，改成 `download_file` / `proxy_status` / `geo_check` 只需改三处字符串与 skill 文案。

### 7.4 `dsh_session_guard`

```
name: dsh_session_guard
description: 让模型连接在代理失能时也不中断。check 只读上报 $DSH_HOME/.env 里 NO_PROXY 对国内 AI 平台
             域名的覆盖情况；apply 合并缺失域名（先备份，且绝不改 HTTP_PROXY / HTTPS_PROXY）；
             restore 用最新备份还原。
parameters:
  action         enum check|apply|restore (default check)
  extra_domains  string[] (optional)  本次额外强制直连的域名
```

写盘只发生在显式 `apply`。返回 `changed` / `added_count` / `backup_path`，并在 `notes` 里提醒**需要重启 DSH**、以及该文件当前没有代理变量时该项暂时无效。

### 7.5 UI 呈现

```js
presentCall: (args) => ({ card: 'generic', kind: 'fetch',
                          title: '下载文件', rawInput: args.url })
presentResult: (args, result) => ({ card: 'generic',
                          title: result.isError ? '下载失败' : '下载完成' })
```

**不做流式进度条**：DSH 工具没有 MCP 那种 `report()` 进度通道。`exec.deferContext()` 可以往会话里插消息，但对几十 MB 的文件会把上下文刷爆——**不用**。进度只体现在：`presentCall` 的卡片、最终返回值里的 `bytes`/`speed_bps`/`elapsed_ms`。超大文件（预计 >5 分钟）建议提示模型用后台 job 语义来跑。

---

## 8. 技能

在 `apply` 里 `ctx.skills.register({...})`，**必须显式给 `source`**（T6）。

```js
ctx.skills.register({
  name: 'smart-download',
  source: 'dsh-downloader',
  whenToUse: '当任务需要从互联网获取文件（安装包、GitHub Release、模型权重、数据集、压缩包、镜像）时',
  description: '用 dsh_download 下载互联网文件：自动境内外分流、直连失败自动回退代理、'
             + '失败不留半截文件、返回 sha256 与保存路径。',
  content: `<正文，从 ZCode 版 SKILL.md 改写>`,
  invocation: { modelInvocable: true, userInvocable: true }
})
```

正文要点（与 ZCode 版的差异已标注）：

1. 需要下载互联网文件时，**直接用 `dsh_download`**，不要先单独跑 `dsh_geo_check`（内部已判定）。
2. 不要用 `Invoke-WebRequest` / `curl` 代替——**它们不走本插件**（这是工具型的固有边界，必须对模型说明）。
3. 只有用户明确问"这个站是国内外/要不要代理"或排查问题时，才单独调 `dsh_geo_check` / `dsh_proxy_status`。
4. 报错"未检测到可用代理出口"时：告诉用户去 **设置 → 下载代理** 填订阅地址或 `proxyUrl`；**不要**因此退回 `curl` 直连，除非用户明确要求。
5. 大文件先按默认 512MB；被上限拦截时与用户确认后再调 `max_mb`。
6. 汇报时引用 `saved_to` / `sha256` / `bytes` / `speed_bps` / `route`。
7. ~~`protect_api`~~ —— 工具型插件不改全局路由，**不存在**"节点抖动导致 API 断连"的风险，删掉这条。

---

## 9. 设置面板（客户端半部，M3）

按 `dsh-notify` 这个已验证的 0.2.0 模板（T7）：

```js
// lib/client.js
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'dsh-downloader',                 // 必须 == cordis.patch.yml 里的 entryId
  order: 91,
  label: () => translate('nav'),
  locale: LOCALE_NS,
  inject: () => ({ scope: getConfigForm(), status: statusSource })
}, DownloaderSettingsSection))
```

三条硬性注意：

1. **惰性取服务**：`ctx.get('configForms')` 而不是硬 inject。0.1.7 删掉了 `settingsScope` 之类的服务，硬 inject 会让整个插件停在 pending（`dsh-notify` 客户端注释里明确记了这一点）。
2. **`subscribe` / `getSnapshot` 是类原型方法**，直接传给 `useSyncExternalStore` 会因 `this` 丢失而崩。必须 `useMemo(() => scope.subscribe.bind(scope))` 或包一层闭包。
3. **只对可编辑字段展示**：`SettingsForms` 只投影 `.volatile()` 字段，表单里出现的键必然是 §6 中打了 ✅ 的那些。

面板内容：
- 头部：状态徽标（`disabled` / `no-subscription` / `running` / `failed`）+ 上游模式 + 本地端口
- 上游：`proxyUrl`、`subscriptionUrl`、`fetchProxyUrl`、`autoUpdateHours`，按钮「更新订阅」
- 节点：组类型、节点列表（名称 / 类型 / 延迟 / 选中态）、「全部测速」、「选择」
- 规则：`extraRules` / `excludeRules` 文本域
- 下载：`downloadDir`、`maxDownloadMb`、`downloadTimeoutS`、`stallTimeoutS`、`insecureTls`
- 实时：内存中的上下行字节数与速率（来自 `ProxyServer.counters`）

数据面走 `webServer.register({ kind:'prefix', path:'/dsh-downloader', handler })`，端点与 `example/dsh-clash` 的 `/clash-proxy/*` 对齐：
`status` · `update-subscription` · `restart` · `proxies` · `delay` · `delay-all` · `select` · `traffic`。

**设置变更的响应**：`Config` 变更后，只有"需要重建内核"的字段（订阅地址、抓取代理、组类型、规则、测速参数、`proxyUrl`）触发 `reconcile()` 重启内核；`downloadDir` / `maxDownloadMb` / 超时 / `insecureTls` 这类**每次调用现读**，不重启。

---

## 10. 复用清单

### 10.1 从 `example/dsh-clash` 原样搬运（vendored）

| 文件 | 搬运方式 | 需要改什么 |
|---|---|---|
| `lib/core/subscription.js` | 原样 | 无（依赖 `js-yaml`） |
| `lib/core/rules.js` | 原样 | 无 |
| `lib/core/data/cn-domains.json.gz` 等 3 个 | 原样 | 无（467KB + 33KB + 4KB） |
| `lib/core/proxy-server.js` | 原样 | 无 |
| `lib/core/transports.js` | 原样 | 无 |
| `lib/core/vmess.js` / `ws.js` | 原样 | 无 |
| `lib/native/connector.exe` + `native/*.go` | 可选 | 默认不打包（见 §4.2） |

**每个文件头部加一段出处注释**（MIT 合规）：

```js
// Vendored from dsh-clash-proxy 0.2.0 (MIT) — https://github.com/…/dsh-clash-proxy
// 本文件未作修改；修改处在此行之下以 `// [dsh-downloader]` 标出。
```

### 10.2 从 `plugins/clash-downloader` 搬运逻辑（重写为 ESM 模块）

| 原位置 | 新位置 | 改动 |
|---|---|---|
| `parseProxyUrl()` / `connectTunnel()` / `openTarget()` / `httpFlow()` / `readBody()` | `lib/download/http.js` | 基本原样；`proxy` 固定为本地内核端口或显式上游 |
| `toolDownloadFile()` 的落盘段（`.part` → sha256 → 上限 → 停滞 → rename） | `lib/download/fetch-file.js` | 拆成纯函数，去掉 MCP 的 `report()` |
| `icmpPing()` / `tcpPing()` / `resolveHost()` / `isPrivateIp()` / `geoLookupIP()` | `lib/download/net-probe.js` | 原样（仅 `dsh_geo_check` 用） |
| `analyzeTarget()` / `toolGeoCheck()` | `lib/download/route.js` + `lib/index.js` | **改为离线 RuleEngine 优先**（§2.3） |
| `filenameFromUrl()` / `humanSize()` / `sanitizeFilename()` | `lib/download/util.js` | 原样 |
| `skills/smart-download/SKILL.md` | `lib/index.js` 里的 `content` | 去掉 `protect_api`、去掉 `clash_status`/`import_subscription`，改工具名 |
| `toolClashStatus()` | `dsh_proxy_status` 的 execute | 改为报告内核状态而不是"探测本机 Clash" |
| `inspectClashYaml()` | `lib/core/subscription.js` 已有等价物 | **丢弃** |
| `toolImportSubscription()` / `protect_api()` / `readSystemProxy()` / `writeProxyOverride()` / `detectTunAdapter()` | — | **全部丢弃**（工具型不需要，且注册表操作用户没要） |

### 10.3 明确不复用

- `example/dsh-clash/lib/**/inject.js`（env + dispatcher 接管）—— 与形态 C 冲突
- `example/dsh-clash/lib/core/manager.js` —— 编排逻辑要按新架构重写
- `example/dsh-clash/lib/index.js` 与 `lib/client.js` —— **0.1.x API，在 0.2.0-rc.2 上不可用**（T3/T7）
- `plugins/clash-downloader/mcp-server.mjs` 的 MCP 协议层（`handleMessage` / `TOOLS` / `dispatch`）—— 换成 `ctx.tools.register`

---

## 11. 安全与边界

### 11.1 已知能力边界（写进 README 与 skill，避免预期落空）

工具型插件**只覆盖它自己的下载调用**。以下出网路径**不走本插件**：

| 路径 | 走不走本插件 | 想要覆盖怎么办 |
|---|---|---|
| `dsh_download` 工具 | ✅ 走 | — |
| `web_fetch` 工具 | ❌ 不走 | 用 DSH 内建 `$DSH_HOME/.env` 全局策略（§3.1） |
| pwsh 里的 `curl` / `git` / `npm` / `Invoke-WebRequest` | ❌ 不走 | 同上 |
| jobs / workflow / subagent 派生的进程 | ❌ 不走 | 同上（它们继承的是 DSH 启动策略） |
| MCP server 的 HTTP 传输 | ❌ 不走 | 同上 |

**这是选 C 的固有代价，必须在 README 首屏讲清楚**，否则用户会以为装了插件就万事大吉。

### 11.2 与 DSH 内建代理共存

- 本插件**从不写 `process.env`**，也**从不调 `setGlobalDispatcher`**。
- 内核模式下，下载流量是 `node:http` 直接连 `127.0.0.1:<本地端口>`，**不经过** undici 全局 dispatcher → 与启动器策略零冲突。
- 唯一间接接触：`fetchSubscription()` 用全局 `fetch`（因此**会**走启动器策略——订阅被墙时这反而是好事）。用户可用 `fetchProxyUrl` 显式覆盖。
- 卸载时：`ctx.effect` 的 disposer 关掉本地监听、清定时器、删内存缓存。**`process.env` 与全局 dispatcher 从头到尾未被触碰**，因此不存在"卸载后残留"。

### 11.3 落盘路径与沙箱

`node:fs` 的流式写入**绕过** DSH 的文件沙箱与 observation policy（`ctx.fs` 只提供 `writeText` / `readBytes`，没有流式写）。折中方案：

```
解析目标路径时（按顺序）：
  1. save_path 显式给出 → 绝对化
  2. 否则 downloadDir（配置）→ 否则 $DSH_HOME/downloads
  3. 若 ctx.fs 可用：ctx.fs.resolve(path) 做一次规范化与包含性检查
  4. 若解析结果不在当前工作区内，且 config.allowOutsideWorkspace === false
     → 抛错，提示"目标在工作区外，请设置 allowOutsideWorkspace 或改用工作区内路径"
  5. 通过则用 node:fs 流式写 `<target>.part`，完成后 rename
```

> 这是"**准入检查用 DSH 策略、实际写入是宿主写**"的折中。必须在 README 的"安全"一节如实说明。若评审要求严格服从沙箱，退路是：只允许写 `ctx.fs` 能表达的目标，代价是放弃流式（大文件内存吃不消）——**不建议**。

### 11.4 其他

| 项 | 措施 |
|---|---|
| 文件名 | `sanitizeFilename()` 去掉路径分隔符与控制字符，禁止 `..` |
| SSRF | 默认允许任意 http/https（这是下载器的本职）。私有/回环 IP 目标只告警不阻断，因为内网下载是合法需求 |
| 大小上限 | 边下边计数，超限立即 destroy 并删除 `.part`（防磁盘打满） |
| 停滞 | 每 5s 检查"距上次收到数据"，超 `stallTimeoutS` 即中止 |
| 取消 | 全程挂 `exec.signal`；中止路径统一删 `.part` |
| TLS | 默认 `insecureTls: false`。企业 TLS 解密环境建议走 `NODE_EXTRA_CA_CERTS` 而不是关校验 |
| 凭据 | 订阅 URL / 抓取代理用 `.role('secret')`；`dsh_proxy_status` 输出里**不得**回显凭据（只报 `subscriptionUrlSet: true/false`） |

---

## 12. 失败模式与降级矩阵

| 场景 | 行为 |
|---|---|
| 无 `proxyUrl` / 无 `$HTTPS_PROXY` / 无 `subscriptionUrl`，目标在境外 | 抛错：`目标在境外，但没有可用代理出口；请在"设置 → 下载代理"填写订阅地址或 proxyUrl` |
| 同上，但目标在境内 | 正常直连下载（`route: 'direct'`，`warnings` 注明无代理） |
| 订阅抓取失败，但本地有缓存 | 用缓存 + `warnings: ['订阅更新失败，使用缓存 (age 3h)']` |
| 订阅抓取失败且无缓存 | 降级到 `mode: 'none'`，同上两条 |
| 订阅解析出 0 个节点 | 报错并提示检查订阅地址；`dsh_proxy_status` 显示 `nodeCount: 0` |
| 选中的节点连不上 | 按 `groupType` 换下一个可用节点；全失败则报错 |
| 直连失败（超时/DNS/连接重置） | `force_route==='auto'` 且上游可用 → 自动改走代理重试一次 |
| 代理也失败 | 抛错，保留两次的原始错误信息 |
| HTTP >= 400 | 抛错，附 URL、状态码、状态文本与响应体前 200 字符 |
| 重定向超过 `maxRedirects` | 抛错 |
| 目标已存在且 `!overwrite` | 抛错并报出已有文件大小 |
| 超过 `max_mb` | 中止 + 删 `.part` + 抛错（提示可调大） |
| 停滞超 `stallTimeoutS` | 中止 + 删 `.part` + 抛错 |
| 超 `downloadTimeoutS` | 中止 + 删 `.part` + 抛错 |
| `exec.signal` 中止（用户取消 / 工具超时） | 中止 + 删 `.part` + 抛中止错误 |
| rename 前发现目标已出现（并发） | 抛错，`.part` 保留或按配置删除 |

**通用不变量**：任何失败路径都**不留** `<target>.part`；任何成功路径都**不留**临时文件。

---

## 13. 关键风险与 Spike 清单

按风险从高到低。**M0 阶段先做 Spike 1–3**，任何一条不通就要回到设计。

| # | 风险 | 为什么危险 | Spike / 缓解 |
|---|---|---|---|
| R1 | 从 `example/dsh-clash` 搬来的 `transports.js` 依赖 Node 版本/全局对象，在 DSH 的 Electron 运行时（v24.18.1）上行为不同 | 内核模式的核心，不通就全废 | 直接 `node test/smoke.mjs` + 本地 socks5/ss 夹具跑通；再在 `dsh web` 里跑一次 |
| R2 | `.volatile()` 与 `.role('secret')` 组合的行为未验证 | 可能导致设置表单渲染异常或凭据被回显 | 起一个最小插件，只放一个 secret volatile 字段，装进测试 profile 看设置页 |
| R3 | `ctx.skills.register` 的 `source` / `whenToUse` 是否被模型正确消费未验证 | 技能是"让模型主动用工具"的唯一抓手，不生效则整个形态失效 | 装进测试 profile，问一句"帮我下个 GitHub release"，看是否命中 `dsh_download` |
| R4 | 订阅节点的 TLS 指纹 / uTLS 需求（部分节点要求 reality） | 需要 12MB 的 `connector.exe`，且仅 Windows amd64 | 默认不打包 + 如实报告能力；M2 再评估 |
| R5 | 大文件下载与工具调用生命周期交互（DSH 侧是否会打断） | 已核实 `timeoutMs` 不声明即无超时（T4），但 `tools/execute` 的其他 wrapper（沙箱、pruning）可能有别的约束 | 用一个 1GB 的真实文件跑一次，观察是否被中途打断 |
| R6 | 本地混合代理端口在插件重载（HMR）后是否泄漏监听 | 反复重载会堆积端口 | 写一个"重载 10 次后 `netstat` 检查"的回归脚本 |
| R7 | `js-yaml` 解析恶意/畸形订阅 | 解析异常 / 原型污染 | 解析包 try/catch + 只取白名单字段；用畸形 YAML 夹具测 |
| R8 | 与用户已有的 `$DSH_HOME/.env` 全局代理叠加时的语义 | 订阅抓取会走全局代理，可能反而失败 | 在两种环境下各跑一次；文档说明 `fetchProxyUrl` 的用途 |

---

## 14. 里程碑

| 阶段 | 内容 | 产出 | 预估 |
|---|---|---|---|
| **M0 骨架与 Spike** | 建仓库、`package.json`、`cordis.patch.yml`、`Config`、vendor 内核、`dsh_proxy_status` 可用；完成 Spike 1–3 | 能装进测试 profile 并在设置页看到状态 | 0.5–1 天 |
| **M1 最小可用下载** | `lib/download/*`（http / fetch-file / route）、`dsh_download`、`dsh_geo_check`、skill；**轻量模式**（显式 `proxyUrl`）端到端跑通 | 能下载真实 GitHub Release，境内直连 / 境外走代理都有验证 | 1 天 |
| **M2 自包含订阅内核** | 订阅抓取/解析/缓存/自动更新、RuleEngine 离线分流、本地 `ProxyServer`、节点测速与选择 | **无本机 Clash** 也能完成境外下载 | 1–2 天 |
| **M3 GUI 与发布** | `lib/client.js` 设置面板、双语 locale、`webServer` API、README（中英）、打包 `npm pack` 校验 | 可发布的 `@having5548/dsh-downloader@0.1.0` | 1–1.5 天 |

---

## 15. 验证计划

### 15.1 单元 / 夹具（`node test/smoke.mjs`）

- `RuleEngine.decide()`：`github.com` → proxy；`baidu.com` → direct；`127.0.0.1` → direct；`extraRules` / `excludeRules` 覆盖生效
- `parseSubscription()`：完整 Clash YAML / 裸节点列表 / base64 包裹 三种输入
- 落盘：`.part` 命名、sha256 正确性、超限中止后无残留、rename 原子性
- `filenameFromUrl()` / `sanitizeFilename()` 边界（`Content-Disposition`、`..`、超长名、无扩展名）

### 15.2 端到端（`node test/proxy-e2e.mjs`）

沿用 `example/dsh-clash/test/` 的夹具：本地 socks5 + ss 服务器 + 本地 HTTP 文件服务器。
**不依赖任何真实节点或外网**。

断言：境外目标走夹具节点、境内目标直连、直连失败自动回退、下载字节与 sha256 一致。

### 15.3 真实 DSH 集成

1. 建测试 profile（不动 `desktop`），`dsh plugin --profile <test> add <本地路径>`
2. 设置页填订阅 URL → 「更新订阅」→ 节点列表出现
3. 对模型说"下载 https://github.com/X/Y/releases/latest/download/app.zip 到 D:\dl"
4. 断言：工具被调用、`route: 'proxy'`、`sha256` 与官方一致、文件完整
5. 断言：`pwsh` 里 `curl https://ipinfo.io` 的出口 **仍**是直连 IP（证明零全局副作用）
6. 断言：`$env:HTTPS_PROXY` 在插件加载前后一致
7. 卸载/禁用插件 → 端口关闭、无残留文件

### 15.4 与内建代理并存的回归

在 `$DSH_HOME/.env` 里设一个假代理，确认：插件的订阅抓取行为符合 §11.2 的描述、下载仍正常。

---

## 16. 命名与发布

| 项 | 值 |
|---|---|
| 包名 | `@having5548/dsh-downloader`（与 `@having5548/dsh-notify` 同 scope） |
| 仓库目录 | `H:\mycode\dsh-downloader` |
| entryId | `dsh-downloader`（`cordis.patch.yml` 与 `configForms.get()` 必须一致） |
| 工具名 | `dsh_download` / `dsh_proxy_status` / `dsh_geo_check` |
| 技能名 | `smart-download` |
| 版本 | `0.1.0`（M3 发布） |
| 协议 | MIT（vendored 部分保留原出处声明） |

**发布前检查清单**：`npm pack --dry-run` 确认 `lib/core/data/*.json.gz` 与 `cordis.patch.yml` 入包、`package.json` 的 `files` 无遗漏、`README` 首屏写明 §11.1 的能力边界、`node test/smoke.mjs` 通过。

---

## 附录 A：已核实的运行时契约（出处）

| 结论 | 出处 |
|---|---|
| 启动器在挂载插件前安装代理策略 | `app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/profile-boot-*.js` → `runProfile()` 首行 `installProxyFromEnvironment(options.environment, report)` |
| 代理策略实现与导出 | `@deepseek-ai/dsh-http-proxy/lib/index.js`，导出 `installProxyFromEnvironment` / `proxyRouteFor` / `proxyEnvironmentForChild` / `clearedProxyEnv` |
| `$DSH_HOME/.env` 是唯一允许写代理变量的 `.env` | `@deepseek-ai/dsh-app-boot/lib/index.js` → `HOME_LAYER_PROXY_NAMES` / `readEnvLayer()` |
| 子进程继承代理并加 `NODE_USE_ENV_PROXY` | `@deepseek-ai/dsh-subprocess/lib/index.js` → `scrubbedParentEnv()`；调用点 `@deepseek-ai/dsh-subprocess-local/lib/runner-launch-*.js` → `childEnv()` |
| `web_fetch` 走代理 | `@deepseek-ai/dsh-web-fetch-http/lib/index.js` L501 `proxyRouteFor(url)` |
| `ToolDefinition` 形状 | `cordis_inspect_query(host, Service, {"service":"tools"})` → `referencedTypes.ToolDefinition` |
| 工具超时是 opt-in | `@deepseek-ai/dsh-tool-call-timeout-policy/lib/index.js` → `if (timeoutMs === void 0) return next()` |
| `dsh-settings` 0.2.0-rc.2 的实际导出 | `@deepseek-ai/dsh-settings/lib/index.js` 末行 `export { SettingsConflictError, SettingsForms, SettingsForms as default, redactSecrets }` |
| 设置表单只投影 volatile 字段 | `@deepseek-ai/dsh-settings/README.zh.md` + `lib/types/index.js` → `volatileForm(schema)` |
| `skills.register` 契约与 `source` 要求 | `@deepseek-ai/dsh-skill/lib/index.js` → `validateRuntimeSkill()` / `runtimeCandidate()` / `validateCandidate()` |
| 客户端设置面板模板 | `H:\mycode\dsh-notify\lib\client.js` L1005（`settings.section`）、L445（`ctx.get('configForms')`）、L352 注释（原型方法必须 bind） |
| 能跑的 0.2.0 插件 `package.json` / `cordis.patch.yml` 模板 | `H:\mycode\dsh-notify\package.json` / `cordis.patch.yml` |
| `sharedPackages` 包含 / 不包含 | `app.asar/dsh/desktop-runtime.json`（287 项；含 `dsh-http-proxy`、`dsh-settings`、`dsh-tools`、`dsh-skill`、`schemastery`；**不含** `undici`、`dsh-client-runtime`） |
| 节点传输 / 规则引擎 / 订阅解析能力 | `example/dsh-clash/lib/core/{transports,rules,subscription,proxy-server}.js` |

## 附录 B：与两个参考插件的差异表

| 维度 | `plugins/clash-downloader`（ZCode） | `example/dsh-clash`（DSH） | **本设计** |
|---|---|---|---|
| 宿主 | ZCode | DSH | DSH `0.2.0-rc.2` |
| 形态 | MCP server + skill | Cordis 插件（双面） | Cordis 插件（双面，工具为主） |
| 模型如何触发 | 模型调用 MCP 工具 | 无需触发（全局接管） | 模型调用工具 + skill 引导 |
| 代理出口 | 探测本机 FlClash | 自包含订阅 | **自包含订阅** 或 **显式配置** |
| 分流依据 | 在线 GeoIP (ip-api.com) | 离线规则引擎 | **离线规则引擎优先**，在线 GeoIP 仅诊断 |
| 对进程的影响 | 无 | 改 `process.env` + 换全局 dispatcher | **无** |
| `web_fetch` 是否覆盖 | 否 | 是 | 否（已文档化） |
| 订阅导入 | `clash://` 深链 + URL | 设置里填 URL | 设置里填 URL（不做深链） |
| API 断连防护 | `protect_api`（改注册表 / 出规则） | 设计上无此风险 | 设计上无此风险（不改全局路由） |
| 设置面 | `~/.zcode/…/config.json` | `installSettingsSection`（**0.1.x API，已失效**） | 模块导出 `Config` + `.volatile()` + 客户端 `configForms` |
| 包体 | ~50KB（纯 JS） | ~13MB（含 Go 连接器） | **~600KB**（默认不含连接器） |
