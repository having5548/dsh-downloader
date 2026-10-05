<div align="center">

# ⬇️ dsh-downloader

**Download proxy plugin for DeepSeek Harness** — foreign targets go through a proxy, domestic ones stay direct. The proxy exit is self-contained (one subscription URL, **no local Clash needed**), and the Chinese AI platform domains are pinned direct so a flapping node or a closed proxy app can never break the session.

[简体中文](README.md) | English

![Version](https://img.shields.io/badge/version-0.1.2-4c7ef3?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078d6?style=flat-square)
![Protocols](https://img.shields.io/badge/nodes-ss%20%7C%20trojan%20%7C%20vless%20%7C%20vmess%20%7C%20socks5%20%7C%20http-2b6cb0?style=flat-square)
![Tests](https://img.shields.io/badge/tests-168%20passed-2fa95e?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

</div>

---

## ✨ Features

| | | |
|---|---|---|
| 🌏 **Foreign via proxy, domestic direct**<br>`dsh_download` decides and downloads in one call — the model never picks a route | 📦 **Self-contained exit**<br>One Clash subscription URL is enough; ss / trojan / vless / vmess / socks5 / http, **no local Clash required** | 🛡️ **Session keep-alive**<br>22 Chinese AI platform domains pinned direct above every other rule, plus `dsh_session_guard` for `$DSH_HOME/.env` |
| 🧮 **Offline routing verdict**<br>110k domestic domain suffixes + 8.7k domestic CIDRs; the decision makes **zero network calls** | 🔁 **Automatic fallback**<br>A failed direct attempt (timeout / DNS / reset) is retried through the proxy once, reported as `fallback_used` | 🔐 **Verifiable integrity**<br>sha256 streamed as it goes; the result carries the path, byte count, speed and the route used |
| 🧯 **No debris on failure**<br>Writes `.part` then renames atomically; **every failure path deletes the partial** | ⏱️ **Large files survive**<br>Host tool timeout deliberately omitted; only your own `downloadTimeoutS` and the stall detector apply | 🖥️ **Settings panel**<br>Status / subscription refresh / node list / per-node latency / group select / live traffic / every config field |

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
dsh plugin --profile desktop add https://github.com/having5548/dsh-downloader/releases/latest/download/having5548-dsh-downloader-0.1.2.tgz
```

Or build and install locally:

```bash
npm pack
dsh plugin --profile desktop add having5548-dsh-downloader-0.1.2.tgz
```

> Profile name: the current Electron desktop app uses `desktop`; the older web CLI used `web`.

Then open **Settings → Download proxy**.

## 🚀 Quick start

1. Open **Settings → Download proxy**.
2. Pick an upstream:
   - **Self-contained (recommended)**: fill `subscriptionUrl` (a Clash subscription) → click "Update subscription" → the node list appears → "Test all" and pick a fast one.
   - **Reuse an existing proxy**: fill `proxyUrl`, e.g. `http://127.0.0.1:7890` or `socks5://127.0.0.1:1080`.
3. Ask the model to download something foreign:

   > Download https://github.com/X/Y/releases/latest/download/app.zip to D:\dl

4. Read `route` from the result: `proxy` = through a node, `direct` = domestic, `fallback_used: true` = the direct attempt failed and the proxy was used.

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
| 1 | `explicit` | `proxyUrl` is set (`http://` or `socks5://`) |
| 2 | `environment` | not set, but `$HTTPS_PROXY` / `$HTTP_PROXY` is (the `.env` above) |
| 3 | `subscription` | `subscriptionUrl` is set — **self-contained, no local Clash needed** |
| 4 | `none` | none of the above: foreign targets fail with an actionable message, domestic ones still download directly |

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `proxyUrl` | empty | explicit upstream |
| `subscriptionUrl` | empty | Clash subscription the self-contained core takes nodes from |
| `fetchProxyUrl` | empty | used only to fetch the subscription itself (must be `http(s)://`) |
| `autoUpdateHours` | `24` | subscription refresh interval; `0` disables |
| `groupType` | `url-test` | `url-test` / `select` / `fallback` |
| `preferredNode` | empty | pin one node by name |
| `latencyTestUrl` / `latencyTimeoutMs` | gstatic 204 / `3000` | node health-check URL and timeout |
| `domesticDirect` | `true` | turn off to send everything through the proxy (**AI platforms still direct**) |
| `protectAiPlatforms` | `true` | pin the Chinese AI platform domains direct at the highest priority |
| `extraDirectDomains` | `[]` | extra domains to force direct (full URLs and `*.x.com` accepted) |
| `extraRules` / `excludeRules` | `[]` | add / drop rule lines |
| `downloadDir` | empty | empty = `$DSH_HOME/downloads` |
| `maxDownloadMb` | `512` | per-file size limit |
| `downloadTimeoutS` | `600` | per-download wall-clock budget |
| `stallTimeoutS` | `30` | abort after this long with no data |
| `insecureTls` | `false` | skip TLS verification (corporate TLS interception only) |
| `allowOutsideWorkspace` | `false` | allow `save_path` outside the workspace and download directory |
| `maxRedirects` | `10` | maximum redirect hops |

Data directory: `$DSH_HOME/dsh-downloader/` (`subscription.yaml` cache, `state.json` node selection).

## 🧰 Tools

| Tool | Purpose |
|---|---|
| `dsh_download` | Download a file. `url` required; optional `save_path` / `overwrite` / `force_route` / `max_mb` / `timeout_seconds`. Returns `saved_to`, `bytes`, `sha256`, `speed_bps`, `route`, `route_reason`, `fallback_used`. |
| `dsh_proxy_status` | Upstream mode, subscription state, node count and latencies, selected node, core port, AI-protection state, session-guard state, last error. |
| `dsh_geo_check` | Verdict on whether a URL or host goes direct or through the proxy. **Uses the embedded offline rule tables first (zero network)**; DNS + online GeoIP + ping only when the tables cannot decide. |
| `dsh_session_guard` | Checks / writes / restores `NO_PROXY` in `$DSH_HOME/.env` (see the session guard above). |

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
| `hysteria2` / `vless reality` | ⚠️ needs the optional Go connector (not bundled; Windows amd64) |
| `tuic` | ❌ |

**To enable hysteria2 / reality**: take `native/connector.exe` from `dsh-clash-proxy` and drop it at `lib/native/connector.exe` inside this package (`dsh_proxy_status` then reports `native connector: present`). Without it those nodes are skipped and counted; other nodes are unaffected.

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
node test/smoke.mjs      # 168 checks: rules / subscription / routing / HTTP client / end-to-end / session guard
node --check lib/client.js
npm pack
```

`test/smoke.mjs` needs **no internet**: it starts a local HTTP fixture server and drives real downloads through the plugin's own `ProxyServer`, verifying sha256 byte-for-byte and covering the size cap, the stall detector, cancellation, 404, redirects, `.part` cleanup, plus assertions like "AI domains stay direct under the strictest rule" and "apply never introduces a proxy variable".

## ⚠️ Known limitations

| Limitation | Detail |
|---|---|
| Own downloads only | See the boundary table at the top; use `$DSH_HOME/.env` for the rest |
| The `save_path` check is not a sandbox | Writes use `node:fs` streaming (`ctx.fs` has no streaming write), so it is "policy-checked admission, host-level write" |
| Filename is derived from the URL by default | `Content-Disposition` is only visible in the result; pass an explicit `save_path` when the name matters |
| No live progress bar | DSH tools have no MCP-style `report()` channel; progress is only in the final `bytes` / `speed_bps` |
| `hysteria2` / `reality` need the connector | See above |
| One data directory per `$DSH_HOME` | Multiple DSH instances share the subscription cache and node selection |
| The session guard writes outside the workspace | Only when `dsh_session_guard action="apply"` (or the panel button) is called explicitly: it backs `$DSH_HOME/.env` up first and edits only the `NO_PROXY` line |

## 📄 License

MIT. The core is derived from `dsh-clash-proxy` 0.2.0 (MIT); see the file headers and [LICENSE](LICENSE).

This plugin only provides technical capability — make sure your proxy service and its use comply with your local laws and regulations.
