<div align="center">

# ⬇️ dsh-downloader

**Download proxy plugin for DeepSeek Harness** — foreign targets go through a proxy, domestic ones stay direct. The proxy exit is self-contained (one subscription URL, **no local Clash needed**), and the Chinese AI platform domains are pinned direct so a flapping node or a closed proxy app can never break the session.

[简体中文](README.md) | English

![Version](https://img.shields.io/badge/version-0.5.2-4c7ef3?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078d6?style=flat-square)
![Protocols](https://img.shields.io/badge/nodes-ss%20%7C%20trojan%20%7C%20vless%20%7C%20vmess%20%7C%20socks5%20%7C%20http-2b6cb0?style=flat-square)
![Tests](https://img.shields.io/badge/tests-366%20passed-2fa95e?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

</div>

---

## ✨ Features

| | | |
|---|---|---|
| 🌏 **Foreign via proxy, domestic direct**<br>`dsh_download` decides and downloads in one call — the model never picks a route | 📦 **Self-contained exit**<br>One subscription is enough, **no local Clash required**; accepts Clash YAML and share-link lists, and speaks ss / trojan / vless / vmess / hysteria2 (with salamander obfs) / socks5 / http | 🛡️ **Session keep-alive**<br>22 Chinese AI platform domains pinned direct above every other rule, plus `dsh_session_guard` for `$DSH_HOME/.env` |
| 🧮 **Offline routing verdict**<br>110k domestic domain suffixes + 8.7k domestic CIDRs; the decision makes **zero network calls** | 🔁 **Automatic fallback**<br>A failed direct attempt (timeout / DNS / reset) is retried through the proxy once, reported as `fallback_used` | 🔐 **Verifiable integrity**<br>sha256 streamed as it goes; the result carries the path, byte count, speed and the route used |
| 🧯 **No debris on failure**<br>Writes `.part` then renames atomically; **every failure path deletes the partial** | ⏱️ **Large files survive**<br>Host tool timeout deliberately omitted; only your own `downloadTimeoutS` and the stall detector apply | 🖥️ **Settings panel**<br>Status / profile import and management / node list / per-node latency / group select / live traffic / every config field | 🗂️ **FlClash-style profiles**<br>Several configurations (subscription URL / clash:// deep link / local file), each with its own label, last-update time and auto-update interval | 🔒 **Serves this plugin's downloads only**<br>The core binds loopback and requires a per-process token; no other program can reach or borrow it, and the system proxy / environment are never touched |

## ⚠️ Read this first: what it covers

This plugin is **tool-type** — it covers only its own downloads.

| Egress path | Routed by this plugin? |
|---|---|
| the `dsh_download` tool | ✅ yes, with domestic/foreign splitting |
| the `web_fetch` tool | ❌ no |
| `curl` / `git` / `npm` / `Invoke-WebRequest` in the shell | ❌ no |
| processes spawned by jobs / workflow / subagent | ❌ no |
| MCP server HTTP transports | ❌ no |

To route **those** as well you need no plugin at all — put this in `$DSH_HOME/.env` (on Windows: `C:\Users\<you>\.dsh\.env`):

```dotenv
HTTPS_PROXY=http://127.0.0.1:7890
HTTP_PROXY=http://127.0.0.1:7890
NO_PROXY=localhost,127.0.0.1,::1,deepseek.com,.deepseek.com
```

and restart DSH. DSH reads that file before mounting any plugin and takes over the global dispatcher, `web_fetch`, and every spawned child process. **Only that file may set proxy variables** — a proxy name in a repository's own `.env` makes DSH refuse to start.

The two can be used together; they do not interfere. This plugin **never mutates `process.env`** and **never replaces a global dispatcher**.

## 📦 Install

From the GitHub release:

```bash
dsh plugin --profile desktop add https://github.com/having5548/dsh-downloader/releases/latest/download/having5548-dsh-downloader-0.5.2.tgz
```

Or build and install locally:

```bash
npm pack
dsh plugin --profile desktop add having5548-dsh-downloader-0.5.2.tgz
```

> Profile name: the current Electron desktop app uses `desktop`; the older web CLI used `web`.

Then open **Settings → Download proxy**.

## 🚀 Quick start

1. Open **Settings → Download proxy**.
2. Import nodes in the **"Node profiles"** card — the three ways FlClash offers:
   - **From a subscription URL**: paste an `https://…`, or a FlClash / Clash Verge style `clash://install-config?url=…` deep link (the URL inside is extracted for you).
   - **From a file**: pick a local `.yaml` / `.yml` configuration.
   - **Leave the name blank** and it is derived the FlClash way: the `Content-Disposition` filename first, then the host.
   Each profile is stored separately with its own **last-update time** and **auto-update toggle/interval** (24 h by default; file profiles never auto-update, same as FlClash).
3. "Use" switches the active profile, "Update" re-downloads it, "Delete" removes it.
4. Or skip the UI entirely and let the model import with the `dsh_profile` tool:

   > Import this subscription: https://example.com/api/v1/client/subscribe?token=xxx

5. Ask the model to download something foreign:

   > Download https://github.com/X/Y/releases/latest/download/app.zip to D:\dl

6. Read `route` from the result: `proxy` = through a node, `direct` = domestic, `fallback_used: true` = the direct attempt failed and the proxy was used.

> The legacy single `subscriptionUrl` field still works: it is consulted only when **no profile exists**. As soon as you import one, the selected profile wins.

## 🔑 Authenticated downloads (GitHub Actions artifacts and friends)

`dsh_download` can carry credentials, but it only accepts a **reference**, never a literal token — tool arguments stay in the session log forever:

```
dsh_download({ url: "<archive_download_url>", save_path: "...", auth: "gh" })
```

| `auth` value | Meaning |
| --- | --- |
| `gh` | The plugin runs `gh auth token --hostname github.com` itself and reads GitHub CLI's own credential store. **Recommended** |
| `env:NAME` | Read an environment variable, e.g. `auth: "env:GH_TOKEN"` |
| `bearer:token` | A literal token — convenient, but it lands in the session log; use only for non-sensitive cases |

`headers` adds arbitrary request headers (string keys and values):

```
dsh_download({ url: "...", save_path: "...", headers: { "X-Api-Key": "..." } })
```

Headers that would break the request (`Host`, `Content-Length`, `Connection`, `Transfer-Encoding`, `Proxy-Authorization`) are **silently ignored** rather than allowed to corrupt the download.

**Credentials are dropped on a cross-host redirect, on purpose**: GitHub's `archive_download_url` 302s to a blob host, where the `Authorization` header is useless, hands your token to a third party, and is sometimes answered with a 400. So `Authorization` / `Cookie` are stripped when the redirect changes host, and kept when it does not.

Credentials apply to **every** request: the initial probe, each segmented Range request, and the single-stream retry after a fallback.
## ⚡ Multi-threaded downloads

When the server supports `Range`, a large file is split across `threads` (4 by default) connections.

**The point is not "cut it into N parts" but how you cut it.** Equal static splits are only fast when every connection is equally fast — one slow connection drags the whole transfer (`total ≈ slowest part × parts / concurrency`). So this follows gopeed (`internal/protocol/http/fetcher.go`):

- start with an even `threads`-way split;
- **whichever connection finishes first steals the front half of the chunk with the most bytes left** (never below 512 KiB — smaller slices are not worth a request);
- a slow chunk therefore keeps getting cut down while fast connections stay busy, until everything is claimed.

| Case | Behaviour |
| --- | --- |
| No `accept-ranges: bytes` | single connection |
| File below 1 MiB | single connection (coordination costs more than it saves) |
| `threads` = 1 | single connection |
| Server **claims Range support but answers 200** | detected, then **falls back to one stream**, never a corrupt file |
| `Content-Range` start mismatch, or the slices do not sum to the declared size | same fallback |

Slices write at their absolute offset in one file (`FileHandle.write` with a position), and sha256 is computed by streaming the merged file afterwards — slices land out of order, so hashing as they arrive would produce the wrong digest.

`via_threads` and `segments` in the result say which path was actually taken; the panel's "Download" card lets you change `threads`.

## 📊 Live traffic in the sidebar

A traffic badge sits in the sidebar foot (next to Settings) showing live up/down rates and cumulative bytes through this plugin's rule core:

```
↑ 1.2 MB/s   340 KB
↓ 3.4 MB/s   1.8 GB
```

- The numbers come from the core's byte counters (`/traffic`) and cover **only this plugin's traffic**, not the whole NIC.
- Collapsed to the 56px rail it switches to a minimal layout showing the download rate only.
- Rates are deltas between samples, so the core caches a sample for 1.2 s — otherwise the panel (every 5 s) and the badge (every 1.5 s) would keep stealing each other's window and the reading would jump.
- Polling drops to 5 s while the page is hidden.
- The badge takes no space when the core is not running.
## 🔒 Proxy scope: only downloads this plugin starts

The proxy serves **only** download requests this plugin initiates. That is not a convention — it is enforced by three hard constraints:

| Constraint | Effect |
|---|---|
| **Binds `127.0.0.1` only** | No other machine on the LAN can reach the listener at all |
| **Per-process random token** | Generated in-process next to the download client; never persisted, never logged. A connection without it gets `407`; SOCKS5 is refused outright because its greeting cannot carry the token |
| **No system proxy, no environment mutation** | Browsers, other apps, and any DSH egress that is not this plugin stay exactly as they were |

`dsh_proxy_status` reports all three in its `scope` field, and the "Upstream" card in the panel states them too.

**In other words**: even if something scanned the port it could not use it — and no traffic other than `dsh_download` has ever passed through this plugin.

## 🧩 git / curl downloads also go through this proxy

`git` and `curl` run in shell child processes, and a tool-type plugin cannot intercept them out of process. So this is implemented as **two halves**:

**① A tool that hands the model a proxied command** (`dsh_run_proxied`):

```
dsh_run_proxied({ command: "git clone https://github.com/x/y.git" })
```

It injects the proxy environment (`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` and the lowercase forms, pointing at this plugin's core) for **that one** shell call, then hands it to the **ordinary shell tool** — the sandbox and permission presets still apply; this is not a side door. Domestic targets are still resolved by the core, and the Chinese AI platform domains go into `NO_PROXY` so they never even reach it.

With `execute=false` it only returns the composed command, for you or the model to run through `pwsh` directly.

**② A tool guard** (`guardShellDownloads`, on by default):

When a shell command looks like a foreign download without a proxy (`git clone|fetch|pull|submodule`, `curl`, `wget`, `Invoke-WebRequest`, with a target the offline rules classify as foreign), it is **denied** with a message pointing at `dsh_run_proxied` or `dsh_download`.

Not denied: a command that already carries a proxy (`HTTP_PROXY`, `curl -x`, `git -c http.proxy`); loopback/private targets; when the core has no usable exit (blocking with no alternative is worse than not blocking); and SSH remotes (`git@github.com:…` is not HTTP, so a proxy environment variable cannot help it).

Turn it off in settings if it gets in the way.

**`git` gets two extra config entries**: besides the `*_PROXY` variables, `dsh_run_proxied` feeds git
`http.proxy` (with credentials) and `http.proxyAuthMethod=basic` through `GIT_CONFIG_COUNT`. The reason is that
**git does not send `Proxy-Authorization` preemptively the way curl does** — with environment variables alone it
gets a `407`. Both entries are harmless to non-git commands, so no command sniffing is involved.

The core's `407` challenge says **`Basic`** (both are accepted: `Bearer <token>` and `Basic dsh:<token>`, but only
Basic is a scheme every client can answer). With `Bearer`, curl/git see a scheme they cannot satisfy and give up
without retrying.

**For a plain file download, prefer `dsh_download`** — it brings sha256, the size cap, the stall detector and fallback. `dsh_run_proxied` exists for cases where git/curl itself is required (cloning a repository, calling an API).

## 🛡️ Session guard: Chinese AI platforms never go through a proxy

A proxy node that flaps kills every long-lived connection routed through it, and every model endpoint this harness talks to is a domestic service that never needed a proxy. This takes two layers, because a tool-type plugin cannot touch the LLM connection.

### Layer 1 — the download path (this plugin's core, on by default)

The platform domains below become `DOMAIN-SUFFIX,<domain>,DIRECT` rules placed at **the highest priority** — ahead of the subscription's own rules, ahead of your `extraRules`, and **still direct when `domesticDirect=false` (everything-through-the-proxy mode)**:

> DeepSeek · 智谱/Z.ai/ChatGLM · Moonshot Kimi · Alibaba Tongyi/DashScope · ByteDance Doubao/Volcano Ark ·
> Baidu ERNIE/Qianfan · Tencent Hunyuan · iFlytek Spark · MiniMax · 01.AI · StepFun · SenseTime ·
> Baichuan · SiliconFlow · Kunlun Tiangong · Huawei Cloud Pangu/ModelArts · NetEase Youdao · Langboat ·
> XVERSE · ModelBest · Mobvoi · SCNet / OpenI

The full list lives in [`lib/core/ai-domains.js`](lib/core/ai-domains.js) (a stale entry is harmless — it just never matches). `extraDirectDomains` adds your own domains or full URLs.

### Layer 2 — the harness's own model connections (one click)

What decides where model traffic goes is DSH's launch-time global proxy policy (`HTTP_PROXY` / `HTTPS_PROXY` in `$DSH_HOME/.env`). Close the proxy app and those connections die — the session dies with them.

Fix it with the `dsh_session_guard` tool (or the "Session guard" card in Settings):

| Action | Effect |
|---|---|
| `check` (default) | Read-only: reports whether that file sets proxy vars and whether the AI domains are already in `NO_PROXY` |
| `apply` | Merges the missing domains into `NO_PROXY`. **Backs the file up first**, and **only ever edits that one line** — `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` are never touched |
| `restore` | Puts the newest backup back; fails loudly when there is none |

Each domain is written in both spellings (`d` and `.d`): DSH matches a bare suffix against subdomains, older curl/git want the leading dot. Other lines and the file's existing line endings are preserved.

> DSH reads that file once at launch, so **a restart is required after `apply`** — the tool result says so too.

## ⚙️ Configuration

The upstream is resolved in this order; the first hit wins:

| # | Mode | Condition |
|---|---|---|
| 1 | `subscription` | a profile exists or `subscriptionUrl` is set — **self-contained, no local Clash needed**, and nodes are selectable |
| 2 | `explicit` | `proxyUrl` is set (`http://` or `socks5://`), or the subscription yielded no nodes |
| 2 | `environment` | not set, but `$HTTPS_PROXY` / `$HTTP_PROXY` is (the `.env` above) |
| 3 | `environment` | neither is set, but `$HTTPS_PROXY` / `$HTTP_PROXY` has a value (the one from `.env`) |
| 4 | `none` | none of the above: foreign targets fail with an actionable message, domestic ones still download directly |

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `proxyUrl` | empty | explicit upstream |
| `subscriptionUrl` | empty | single subscription URL (same source as a profile import); **takes priority over `proxyUrl`** |
| `fetchProxyUrl` | empty | used only to fetch the subscription itself (must be `http(s)://`) |
| `autoUpdateHours` | `24` | refresh interval of the legacy single subscription, and the default interval for newly imported profiles; `0` disables |
| `groupType` | `url-test` | `url-test` / `select` / `fallback` |
| `preferredNode` | empty | pin one node by name |
| `latencyTestUrl` / `latencyTimeoutMs` | gstatic 204 / `3000` | node health-check URL and timeout |
| `domesticDirect` | `true` | turn off to send everything through the proxy (**AI platforms still direct**) |
| `protectAiPlatforms` | `true` | pin the Chinese AI platform domains direct at the highest priority |
| `extraDirectDomains` | `[]` | extra domains to force direct (full URLs and `*.x.com` accepted) |
| `guardShellDownloads` | `true` | deny foreign shell downloads that carry no proxy, pointing at `dsh_run_proxied` |
| `extraRules` / `excludeRules` | `[]` | add / drop rule lines |
| `downloadDir` | empty | empty = `$DSH_HOME/downloads` |
| `maxDownloadMb` | `512` | per-file size limit |
| `downloadTimeoutS` | `600` | per-download wall-clock budget |
| `threads` | `4` | segmented connection count; `1` = single stream. Falls back to one connection when the server lacks `Range`, answers it dishonestly, or the file is under 1 MiB |
| `stallTimeoutS` | `30` | abort after this long with no data |
| `insecureTls` | `false` | skip TLS verification (corporate TLS interception only) |
| `allowOutsideWorkspace` | `false` | allow `save_path` outside the workspace and download directory |
| `maxRedirects` | `10` | maximum redirect hops |

Data directory: `$DSH_HOME/dsh-downloader/` — `profiles.json` (the profile list) plus `profiles/<id>.yaml` (each imported configuration), alongside the legacy `subscription.yaml` cache and `state.json` node selection.

## 🧰 Tools

| Tool | Purpose |
|---|---|
| `dsh_download` | Download a file. `url` required; optional `save_path` / `overwrite` / `force_route` / `max_mb` / `timeout_seconds`. Returns `saved_to`, `bytes`, `sha256`, `speed_bps`, `route`, `route_reason`, `fallback_used`. |
| `dsh_proxy_status` | Upstream mode, subscription state, node count and latencies, selected node, core port, AI-protection state, session-guard state, last error. |
| `dsh_geo_check` | Verdict on whether a URL or host goes direct or through the proxy. **Uses the embedded offline rule tables first (zero network)**; DNS + online GeoIP + ping only when the tables cannot decide. |
| `dsh_session_guard` | Checks / writes / restores `NO_PROXY` in `$DSH_HOME/.env` (see the session guard above). |
| `dsh_profile` | Manages node profiles (FlClash-style): list / import from a subscription URL or a `clash://` deep link / import from configuration text / update / select / delete / toggle auto-update / reorder / rename. |
| `dsh_run_proxied` | Runs a `git` / `curl` style shell download through this plugin's proxy, for that one call only (still via the ordinary shell tool and its permission policy). |

It also registers a runtime skill, **`smart-download`**, which makes the model prefer `dsh_download` over `curl` for internet downloads.

### Routing semantics

- **The verdict is offline**: 110k domestic domain suffixes + 8.7k domestic CIDRs, plus the subscription's own rules and your `extraRules`, matched as `DOMAIN` / `DOMAIN-SUFFIX` / `DOMAIN-KEYWORD` / `IP-CIDR` / `REJECT`. No network call, so a blocked GeoIP service cannot break it.
- **Chinese AI platform domains are always direct**: inserted ahead of every other rule and not overridable by a user rule (unless `protectAiPlatforms` is off).
- **Loopback and private addresses never enter a proxy** (`127.0.0.0/8`, `::1`, `.local`, private ranges) — not even with `force_route=proxy`.
- A `direct` verdict **never touches the core**; a `proxy` verdict goes through the local core → node.
- When a direct attempt fails and an upstream is available, the download is **retried through the proxy once**, reported as `fallback_used: true`.

### Integrity semantics

- Writes `<target>.part` first and only then renames atomically; **every failure path removes the `.part`**.
- sha256 is computed while streaming, the byte cap is enforced while streaming, a stall detector aborts a dead transfer, and `exec.signal` cancels the whole thing.
- The host tool timeout is deliberately omitted (DSH's `timeoutMs` is opt-in), so large files are never cut off by the framework — only by `downloadTimeoutS`.

## 🌐 Node protocols

| Protocol | Supported |
|---|---|
| `socks5` / `http` | ✅ |
| `ss` (aes-128-gcm / aes-256-gcm / chacha20-ietf-poly1305) | ✅ |
| `trojan` (tcp / tls / ws) | ✅ |
| `vless` (tcp / tls / ws) | ✅ |
| `vmess` (AEAD alterId=0, tcp / ws) | ✅ |
| `hysteria2` (incl. `salamander` obfs) | ✅ bundled Go connector (Windows amd64) |
| `vless reality` | ✅ same connector |
| `tuic` | ❌ |

**The native connector is bundled**: `lib/native/connector.exe` (self-compiled, with hysteria2's salamander obfs and vless reality). `dsh_proxy_status` reports `native connector: present`. On platforms other than Windows amd64 those nodes are skipped and counted; other nodes are unaffected.

## 📥 Subscription formats

| Format | Notes |
|---|---|
| Clash / mihomo YAML | `proxies` + `proxy-groups` + `rules`, fully supported |
| **base64-wrapped YAML** | what a `?flag=clash` style endpoint often returns |
| **Share-link lists** (base64 or plain) | one `hysteria2://` / `ss://` / `trojan://` / `vmess://` / `vless://` / `socks5://` / `http(s)://` per line — one of the most common provider formats |

Share links are converted into node objects equivalent to Clash YAML, so nothing downstream (rule engine, transports) had to change. Lines that cannot be read are **counted and reported** (`订阅已加载 9 个节点（跳过 2 条）`) rather than silently dropped.

> `ss` with a plugin (`?plugin=…`) and `tuic` are explicitly reported as unsupported instead of pretending to load.

## 🔗 How it relates to DSH's built-in proxy

- This plugin **never writes `process.env`** and **never calls `setGlobalDispatcher`**, so there is no unload residue and no fight with the launcher's policy.
- In core mode, download traffic is `node:http` to `127.0.0.1:<local port>` and never passes through undici's global dispatcher.
- The one indirect touch: subscription fetching uses the plugin's own HTTP client, falling back to `$HTTPS_PROXY` / `$HTTP_PROXY` when `fetchProxyUrl` is empty.

## 🔧 How it works

```
model → dsh_download
         │
         ├─ 1. resolve the upstream   explicit / environment / subscription / none
         ├─ 2. decide offline         embedded CN tables + AI protection + subscription rules + extraRules
         │
         ├─ direct ──────────► connect straight to the target
         └─ proxy  ──────────► 127.0.0.1:<random port> loopback mixed proxy
                                    │
                               RuleEngine decides
                                    ├─ direct → connect straight
                                    └─ proxy  → connectThrough(node)
                                                   ss / trojan / vless / vmess /
                                                   socks5 / http / hysteria2

  the rest of the system, and DSH's other egress — completely unaffected
```

The core (rule engine, CN data, loopback mixed proxy, node transports, subscription parsing) is derived from `dsh-clash-proxy` 0.2.0 (MIT); every derived file keeps a provenance header. This repository **fixes a real truncation bug** on top of it: `SocketBuffer.readAny()` consulted `#ended` before its buffer, so bytes that had already arrived but had not yet been consumed when the socket closed were silently dropped — measured as a 512 KiB response truncated to 384 KiB, i.e. a silently corrupt download. See the `[dsh-downloader]` marker in `lib/core/transports.js`.

## 🧪 Development

```bash
npm install
node test/smoke.mjs      # 366 checks: rules / subscriptions / profile import / routing / HTTP client / end-to-end / session guard / token gate
node --check lib/client.js
npm pack
```

`test/smoke.mjs` needs **no internet**: it starts a local HTTP fixture server and drives real downloads through the plugin's own `ProxyServer`, verifying sha256 byte-for-byte and covering the size cap, the stall detector, cancellation, 404, redirects, `.part` cleanup, plus assertions like "AI domains stay direct under the strictest rule", "a connection without the token gets 407", and "apply never introduces a proxy variable".

## ⚠️ Known limitations

| Limitation | Detail |
|---|---|
| Own downloads only | See the boundary table at the top; use `$DSH_HOME/.env` for the rest |
| The `save_path` check is not a sandbox | Writes use `node:fs` streaming (`ctx.fs` has no streaming write), so it is "policy-checked admission, host-level write" |
| Filename is derived from the URL by default | `Content-Disposition` is only visible in the result; pass an explicit `save_path` when the name matters |
| No live progress bar | DSH tools have no MCP-style `report()` channel; progress is only in the final `bytes` / `speed_bps` |
| The native connector is Windows-amd64 only | `lib/native/connector.exe` is a Windows amd64 binary; other platforms skip hysteria2 / reality nodes and count them |
| One data directory per `$DSH_HOME` | Multiple DSH instances share the profile list, subscription cache and node selection |
| SOCKS5 inbound is refused in token mode | A SOCKS5 greeting cannot carry the token, so the protocol is refused outright; this plugin's own client uses HTTP CONNECT and is unaffected |
| The session guard writes outside the workspace | Only when `dsh_session_guard action="apply"` (or the panel button) is called explicitly: it backs `$DSH_HOME/.env` up first and edits only the `NO_PROXY` line |

## 📄 License

MIT. The core is derived from `dsh-clash-proxy` 0.2.0 (MIT); see the file headers and [LICENSE](LICENSE).

This plugin only provides technical capability — make sure your proxy service and its use comply with your local laws and regulations.
