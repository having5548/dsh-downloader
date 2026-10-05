# @having5548/dsh-downloader

**Foreign through a proxy, domestic direct, self-contained** — a download-proxy plugin for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

It registers a `dsh_download` tool for the model: the plugin decides the route itself, sending
domestic targets direct and foreign targets through its own proxy core, then retrying a failed direct
attempt through the proxy. It reports the saved path, byte count, sha256, speed, and the route used.
The proxy exit needs **no local Clash** — one subscription URL is enough, or an explicit `proxyUrl`.

**It also pins the Chinese AI platform domains to DIRECT, always outside the proxy** — a flapping node
or a closed proxy app can never break a model connection.

---

## 🛡️ Session guard: Chinese AI platforms never go through a proxy

A proxy node that flaps kills every long-lived connection routed through it; and every model endpoint
this harness talks to is a domestic service that never needed a proxy. **Two layers of protection:**

### Layer 1 — the download path (this plugin's core, on by default)

The platform domains below become `DOMAIN-SUFFIX,<domain>,DIRECT` rules placed at **the highest priority** —
ahead of the subscription's own rules, ahead of your `extraRules`, and **still direct when
`domesticDirect=false` (everything-through-the-proxy mode)**:

> DeepSeek · 智谱/Z.ai/ChatGLM · Moonshot Kimi · Alibaba Tongyi/DashScope · ByteDance Doubao/Volcano Ark ·
> Baidu ERNIE/Qianfan · Tencent Hunyuan · iFlytek Spark · MiniMax · 01.AI · StepFun · SenseTime ·
> Baichuan · SiliconFlow · Kunlun Tiangong · Huawei Cloud Pangu/ModelArts · NetEase Youdao · Langboat ·
> XVERSE · ModelBest · Mobvoi · SCNet / OpenI

The full list lives in `lib/core/ai-domains.js` (a stale entry is harmless — it just never matches).
`extraDirectDomains` adds your own domains or full URLs.

### Layer 2 — the harness's own model connections (needs one click)

**This plugin is tool-type and never touches the LLM connection**, so layer 1 cannot protect the session
itself. What decides where model traffic goes is DSH's launch-time proxy policy:
`HTTP_PROXY` / `HTTPS_PROXY` in `$DSH_HOME/.env`. Close the proxy app and those connections die — the
session dies with them.

Fix it with the `dsh_session_guard` tool (or the "Session guard" card in Settings):

| Action | Effect |
|---|---|
| `check` (default) | Read-only: reports whether that file sets proxy vars and whether the AI domains are already in `NO_PROXY` |
| `apply` | Merges the missing domains into `NO_PROXY`. **Backs the file up first**, and **only ever edits that one line** — `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` are never touched |
| `restore` | Puts the newest backup back |

DSH reads that file once at launch, so **a restart is required after `apply`**.

---

## ⚠️ Read this first: what it does and does not cover

This plugin covers **its own downloads only** (the `dsh_download` tool).

| Egress path | Routed by this plugin? |
|---|---|
| the `dsh_download` tool | ✅ yes, with domestic/foreign splitting |
| the `web_fetch` tool | ❌ no |
| `curl` / `git` / `npm` / `Invoke-WebRequest` in the shell | ❌ no |
| processes spawned by jobs / workflow / subagent | ❌ no |
| MCP server HTTP transports | ❌ no |

To route **those** as well you need no plugin at all — put this in `$DSH_HOME/.env`
(on Windows: `C:\Users\<you>\.dsh\.env`):

```dotenv
HTTPS_PROXY=http://127.0.0.1:7890
HTTP_PROXY=http://127.0.0.1:7890
NO_PROXY=localhost,127.0.0.1,::1,deepseek.com,.deepseek.com
```

and restart DSH. DSH reads that file before mounting any plugin and takes over the global dispatcher,
`web_fetch`, and every spawned child process. **Only that file may set proxy variables** — a proxy name
in a repository's own `.env` makes DSH refuse to start.

The two can be used together; they do not interfere. This plugin **never mutates `process.env`** and
**never replaces a global dispatcher**.

---

## Install

```powershell
dsh plugin --profile desktop add @having5548/dsh-downloader
```

Or install it from the DSH plugin market / plugin manager. Then open **Settings → Download proxy**.

---

## Configuration (Settings → Download proxy)

The upstream is resolved in this order; the first hit wins:

| # | Mode | Condition |
|---|---|---|
| 1 | `explicit` | `proxyUrl` is set (`http://` or `socks5://`) |
| 2 | `environment` | not set, but `$HTTPS_PROXY` / `$HTTP_PROXY` is (the `.env` above) |
| 3 | `subscription` | `subscriptionUrl` is set — **self-contained, no local Clash needed** |
| 4 | `none` | none of the above: foreign targets fail with an actionable message, domestic ones still download directly |

Common fields:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `proxyUrl` | empty | explicit upstream |
| `subscriptionUrl` | empty | Clash subscription the self-contained core takes nodes from |
| `fetchProxyUrl` | empty | used only to fetch the subscription itself (must be `http(s)://`) |
| `autoUpdateHours` | `24` | subscription refresh interval; `0` disables |
| `groupType` | `url-test` | `url-test` / `select` / `fallback` |
| `preferredNode` | empty | pin one node by name |
| `domesticDirect` | `true` | turn off to send everything through the proxy (AI platforms still direct) |
| `protectAiPlatforms` | `true` | pin the Chinese AI platform domains to direct at the highest priority |
| `extraDirectDomains` | `[]` | extra domains to force direct (full URLs accepted) |
| `extraRules` / `excludeRules` | `[]` | add / drop rule lines |
| `downloadDir` | empty | empty = `$DSH_HOME/downloads` |
| `maxDownloadMb` | `512` | per-file size limit |
| `downloadTimeoutS` | `600` | per-download wall-clock budget |
| `stallTimeoutS` | `30` | abort after this long with no data |
| `insecureTls` | `false` | skip TLS verification (corporate TLS interception only) |
| `allowOutsideWorkspace` | `false` | allow `save_path` outside the workspace and download directory |

Data directory: `$DSH_HOME/dsh-downloader/` (`subscription.yaml` cache, `state.json` node selection).

---

## Tools

| Tool | Purpose |
|---|---|
| `dsh_download` | Download a file. `url` required; optional `save_path` / `overwrite` / `force_route` / `max_mb` / `timeout_seconds`. Returns `saved_to`, `bytes`, `sha256`, `speed_bps`, `route`, `route_reason`, `fallback_used`. |
| `dsh_proxy_status` | Upstream mode, subscription state, node count and latencies, selected node, core port, last error. |
| `dsh_geo_check` | Verdict on whether a URL or host goes direct or through the proxy. **Uses the embedded offline rule tables first (zero network)**; DNS + online GeoIP + ping only when the tables cannot decide. |
| `dsh_session_guard` | Checks / writes / restores `NO_PROXY` in `$DSH_HOME/.env` so model connections bypass the global proxy (see the session guard above). |

It also registers a runtime skill, **`smart-download`**, which makes the model prefer `dsh_download`
over `curl` for internet downloads.

### Routing semantics

- **The verdict is offline**: 110k domestic domain suffixes + 8.7k domestic CIDRs, plus the
  subscription's own rules and your `extraRules`, matched as `DOMAIN` / `DOMAIN-SUFFIX` /
  `DOMAIN-KEYWORD` / `IP-CIDR` / `REJECT`. No network call, so a blocked GeoIP service cannot break it.
- **Chinese AI platform domains are always direct**: they are inserted ahead of every other rule and
  cannot be overridden by a user rule (unless `protectAiPlatforms` is turned off).
- **Loopback and private addresses never enter a proxy** (`127.0.0.0/8`, `::1`, `.local`, private
  ranges) — not even with `force_route=proxy`.
- A `direct` verdict **never touches the core**; a `proxy` verdict goes through the local core → node.
- When a direct attempt fails (timeout / DNS / connection reset) and an upstream is available, the
  download is **retried through the proxy once**; the result reports `fallback_used: true`.

### Integrity semantics

- Writes `<target>.part` first and only then renames atomically; **every failure path removes the `.part`**.
- sha256 is computed while streaming, the byte cap is enforced while streaming, a stall detector aborts
  a dead transfer, and `exec.signal` cancels the whole thing.
- The host tool timeout is deliberately omitted (DSH's `timeoutMs` is opt-in), so large files are never
  cut off by the framework — only by `downloadTimeoutS`.

---

## Node protocols

| Protocol | Supported |
|---|---|
| `socks5` / `http` | ✅ |
| `ss` (aes-128-gcm / aes-256-gcm / chacha20-ietf-poly1305) | ✅ |
| `trojan` (tcp / tls / ws) | ✅ |
| `vless` (tcp / tls / ws) | ✅ |
| `vmess` (AEAD alterId=0, tcp / ws) | ✅ |
| `hysteria2` / `vless reality` | ⚠️ needs the optional Go connector (not bundled; Windows amd64) |
| `tuic` | ❌ |

**To enable hysteria2 / reality**: take `native/connector.exe` from `dsh-clash-proxy` and drop it at
`lib/native/connector.exe` inside this package (`dsh_proxy_status` then reports
`native connector: present`). Without it those nodes are skipped and counted; other nodes are unaffected.

---

## How it relates to DSH's built-in proxy

- This plugin **never writes `process.env`** and **never calls `setGlobalDispatcher`**, so there is no
  unload residue and no fight with the launcher's policy.
- In core mode, download traffic is `node:http` to `127.0.0.1:<local port>` and never passes through
  undici's global dispatcher.
- The one indirect touch: subscription fetching uses the plugin's own HTTP client, falling back to
  `$HTTPS_PROXY` / `$HTTP_PROXY` when `fetchProxyUrl` is empty.

---

## How it works

```
model → dsh_download
         │
         ├─ 1. resolve the upstream   explicit / environment / subscription / none
         ├─ 2. decide offline         embedded CN tables + subscription rules + extraRules
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

The core (rule engine, CN data, loopback mixed proxy, node transports, subscription parsing) is derived
from [`dsh-clash-proxy`](https://github.com/) 0.2.0 (MIT); every derived file keeps a provenance header.
This repository **fixes a real truncation bug** on top of it: `SocketBuffer.readAny()` consulted
`#ended` before its buffer, so bytes that had already arrived but had not yet been consumed when the
socket closed were silently dropped — measured as a 512 KiB response truncated to 384 KiB, i.e. a
silently corrupt download. See the `[dsh-downloader]` marker in `lib/core/transports.js`.

---

## Development

```bash
npm install
node test/smoke.mjs      # 85 checks: rules / subscription / routing / HTTP client / end-to-end download
npm pack                 # produce the tgz
```

`test/smoke.mjs` needs no internet: it starts a local HTTP fixture server and drives real downloads
through the plugin's own `ProxyServer`, verifying sha256 byte-for-byte and covering the size cap, the
stall detector, cancellation, 404, redirects, and `.part` cleanup.

---

## Known limitations

| Limitation | Detail |
|---|---|
| Own downloads only | See the boundary table at the top; use `$DSH_HOME/.env` for the rest |
| The `save_path` check is not a sandbox | Writes use `node:fs` streaming (`ctx.fs` has no streaming write), so it is "policy-checked admission, host-level write" |
| Filename is derived from the URL by default | `Content-Disposition` is only visible in the result; pass an explicit `save_path` when the name matters |
| No live progress bar | DSH tools have no MCP-style `report()` channel; progress is only in the final `bytes` / `speed_bps` |
| `hysteria2` / `reality` need the connector | See above |
| One data directory per `$DSH_HOME` | Multiple DSH instances share the subscription cache and node selection |
| The session guard writes a file outside the workspace | Only when `dsh_session_guard action="apply"` (or the panel button) is called explicitly: it backs `$DSH_HOME/.env` up first, is restorable, and edits only the `NO_PROXY` line — never a proxy variable |

---

## License

MIT. The core is derived from `dsh-clash-proxy` 0.2.0 (MIT); see the file headers and `LICENSE`.

This plugin only provides technical capability — make sure your proxy service and its use comply with
your local laws and regulations.
