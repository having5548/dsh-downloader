/**
 * dsh-downloader — host half.
 *
 * Registers three agent tools and one runtime skill so the model downloads
 * internet files through the plugin's own rule-splitting proxy instead of a
 * bare `curl`:
 *
 * - `dsh_download`      streaming download with integrity + automatic routing
 * - `dsh_proxy_status`  upstream / node / rule diagnostics
 * - `dsh_geo_check`     offline-first domestic-vs-foreign verdict
 *
 * Scope note: this plugin deliberately registers **tools only**. It never
 * mutates `process.env` and never replaces a global dispatcher, so `web_fetch`,
 * `curl`, `git`, and `npm` are untouched. To route those as well, use DSH's
 * built-in launch-time proxy policy (`$DSH_HOME/.env`).
 * @module dsh-downloader
 */
import z from "@deepseek-ai/schemastery";
import { isVolatile } from "@deepseek-ai/cosmokit";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { UpstreamManager } from "./core/upstream.js";
import { decideRoute, NoUpstreamError } from "./download/route.js";
import { downloadWithFallback } from "./download/fetch-file.js";
import { geoLookupIP, icmpPing, resolveHost, tcpPing } from "./download/net-probe.js";
import { filenameFromUrl, humanSize, isPrivateIp } from "./download/util.js";

/** Cordis plugin name used by loader diagnostics. */
const name = "dsh-downloader";

/**
 * Hard dependency: the tool registry is the plugin's entire public surface.
 * Everything else (`skills`, `webServer`, `settings`, `timer`) is resolved
 * lazily, because a missing service in `inject` parks the whole plugin in
 * `pending` without any error being reported.
 */
const inject = ["tools"];

/** Stable entry id; must equal `cordis.patch.yml`'s `id` and the client's form key. */
const ENTRY_ID = "dsh-downloader";

/** JSON Schema used for every tool's structured output. */
const OBJECT_OUTPUT_SCHEMA = { type: "object", additionalProperties: true };

/** Settings namespace the management panel lives in (informational). */
const SETTINGS_NAMESPACE = ENTRY_ID;

/** Config key order, reused by the client panel. */
const CONFIG_KEYS = [
	"enabled",
	"proxyUrl",
	"subscriptionUrl",
	"fetchProxyUrl",
	"autoUpdateHours",
	"groupType",
	"preferredNode",
	"latencyTestUrl",
	"latencyTimeoutMs",
	"domesticDirect",
	"extraRules",
	"excludeRules",
	"downloadDir",
	"maxDownloadMb",
	"downloadTimeoutS",
	"stallTimeoutS",
	"insecureTls",
	"allowOutsideWorkspace",
	"maxRedirects"
];

/**
 * Every field is `.volatile()` because `@deepseek-ai/dsh-settings` only
 * projects volatile fields into an editable form — without it the management
 * panel has nothing to bind to.
 */
const Config = z.object({
	enabled: z.boolean().default(true).description("Enable the download proxy (tools fail fast when off)").volatile(),
	proxyUrl: z.string().role("secret").default("").description("Explicit upstream proxy, e.g. http://127.0.0.1:7890 or socks5://127.0.0.1:1080").volatile(),
	subscriptionUrl: z.string().role("secret").default("").description("Clash subscription URL for the self-contained node core").volatile(),
	fetchProxyUrl: z.string().role("secret").default("").description("Optional http(s) proxy used only to fetch the subscription itself").volatile(),
	autoUpdateHours: z.number().step(1).min(0).default(24).description("Subscription auto-update interval in hours (0 disables)").volatile(),
	groupType: z.union([z.const("url-test"), z.const("select"), z.const("fallback")]).default("url-test").description("Node selection strategy").volatile(),
	preferredNode: z.string().default("").description("Pin one node by name (overrides the strategy)").volatile(),
	latencyTestUrl: z.string().default("http://www.gstatic.com/generate_204").description("URL used for node health checks").volatile(),
	latencyTimeoutMs: z.number().step(100).min(500).max(10000).default(3000).description("Per-node latency test timeout (ms)").volatile(),
	domesticDirect: z.boolean().default(true).description("Send domestic targets direct and only foreign ones through the proxy").volatile(),
	extraRules: z.array(z.string()).default([]).description('Extra rule lines, e.g. "DOMAIN-SUFFIX,example.com,DIRECT"').volatile(),
	excludeRules: z.array(z.string()).default([]).description("Subscription rule lines to drop (substring match)").volatile(),
	downloadDir: z.string().default("").description("Default download directory (empty = $DSH_HOME/downloads)").volatile(),
	maxDownloadMb: z.number().min(1).default(512).description("Per-file size limit in MB").volatile(),
	downloadTimeoutS: z.number().min(1).default(600).description("Per-download wall-clock budget in seconds").volatile(),
	stallTimeoutS: z.number().min(5).default(30).description("Abort when no data arrives for this many seconds").volatile(),
	insecureTls: z.boolean().default(false).description("Skip TLS verification (corporate TLS interception only)").volatile(),
	allowOutsideWorkspace: z.boolean().default(false).description("Allow save_path outside the workspace and the configured download directory").volatile(),
	maxRedirects: z.number().step(1).min(0).max(30).default(10).description("Maximum redirect hops").volatile()
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Recursively unwrap schemastery `Volatile` containers into plain values. */
function plain(value) {
	if (isVolatile(value)) return plain(value.get());
	if (Array.isArray(value)) return value.map(plain);
	if (value === null || typeof value !== "object") return value;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return value;
	return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]));
}

/** Harness home directory. */
function dshHome() {
	return process.env.DSH_HOME ?? path.join(homedir(), ".dsh");
}

/** Default download directory. */
function defaultDownloadDir() {
	return path.join(dshHome(), "downloads");
}

/** Case-insensitive containment test that also works for not-yet-existing paths. */
function isInside(child, parent) {
	const from = path.resolve(parent);
	const to = path.resolve(child);
	if (process.platform === "win32") {
		const a = from.toLowerCase();
		const b = to.toLowerCase();
		return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
	}
	return to === from || to.startsWith(from.endsWith("/") ? from : `${from}/`);
}

/** The session workspace root, best effort. */
function workspaceRoot(ctx, exec) {
	const fromAgent = exec?.agent?.session?.header?.cwd;
	if (typeof fromAgent === "string" && fromAgent.length > 0) return fromAgent;
	const profile = ctx.get?.("profileContext");
	if (profile !== undefined && typeof profile.cwd === "string" && profile.cwd.length > 0) return profile.cwd;
	return process.cwd();
}

/** Turn a tool's JSON value into the model-facing text block. */
function text(value) {
	return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
}

/** Render a possibly-absent field without printing `undefined` or `NaN` at the model. */
function shown(value, fallback = "(unknown)") {
	if (value === null || value === undefined) return fallback;
	if (typeof value === "number" && !Number.isFinite(value)) return fallback;
	return value;
}

/** Render one download result as a compact, quotable report. */
function renderDownload(value) {
	if (value === null || typeof value !== "object") return text(value);
	const lines = [];
	if (value.ok !== true) {
		lines.push(`Download failed: ${shown(value.error, "unknown error")}`);
		if (value.hint !== null && value.hint !== undefined) lines.push(`hint: ${value.hint}`);
		return text(lines.join("\n"));
	}
	lines.push(`Downloaded ${humanSize(value.bytes ?? 0)} in ${(((value.elapsed_ms ?? 0) / 1000)).toFixed(1)}s (${humanSize(value.speed_bps ?? 0)}/s)`);
	lines.push(`saved_to: ${shown(value.saved_to)}`);
	lines.push(`route: ${shown(value.route)} — ${shown(value.route_reason)}`);
	if (value.fallback_used === true) lines.push("note: the direct attempt failed and the download was retried through the proxy");
	if (value.upstream !== null && value.upstream !== undefined) {
		lines.push(`upstream: mode=${shown(value.upstream.mode)}${value.upstream.node === null || value.upstream.node === undefined ? "" : ` node=${value.upstream.node} (${shown(value.upstream.node_type)})`}`);
	}
	lines.push(`sha256: ${shown(value.sha256)}`);
	const http = value.http ?? {};
	const declared = http.content_length;
	const declaredText = typeof declared === "number" && Number.isFinite(declared) ? `, declared ${humanSize(declared)}` : "";
	lines.push(`http: ${shown(http.status)}${http.redirects > 0 ? ` after ${http.redirects} redirect(s)` : ""}${declaredText}`);
	if (Array.isArray(value.warnings) && value.warnings.length > 0) lines.push(`warnings: ${value.warnings.join("; ")}`);
	return text(lines.join("\n"));
}

/** Render the status object as readable lines (the raw JSON stays in `value`). */
function renderStatus(value) {
	if (value === null || typeof value !== "object") return text(value);
	const lines = [
		`state: ${shown(value.state)}`,
		`mode: ${shown(value.mode)} — ${shown(value.reason)}`,
		`rule core: ${value.port > 0 ? `127.0.0.1:${value.port}` : "not running"}`,
		`nodes: ${shown(value.node_count, 0)}${value.unsupported_nodes > 0 ? ` (${value.unsupported_nodes} unsupported)` : ""}`,
		`selected node: ${shown(value.selected, "(auto)")}`,
		`domestic-direct: ${shown(value.domestic_direct)}`,
		`native connector: ${value.native_connector === true ? "present" : "absent (hysteria2 / reality nodes are skipped)"}`,
		`subscription URL set: ${shown(value.subscription_url_set)} | proxy URL set: ${shown(value.proxy_url_set)} | env proxy: ${shown(value.env_proxy, "none")}`
	];
	if (value.last_subscription_update) lines.push(`last subscription update: ${new Date(value.last_subscription_update).toLocaleString()}`);
	if (value.error !== null && value.error !== undefined) lines.push(`last error: ${value.error}`);
	if (Array.isArray(value.nodes) && value.nodes.length > 0) {
		lines.push("nodes:");
		for (const node of value.nodes.slice(0, 40)) {
			const delay = typeof node.delay === "number" && Number.isFinite(node.delay) ? ` ${node.delay}ms` : "";
			lines.push(`  - ${node.name} [${shown(node.type)}]${delay}${node.needs_native ? " (needs the native connector)" : ""}`);
		}
		if (value.nodes.length > 40) lines.push(`  … ${value.nodes.length - 40} more`);
	}
	if (Array.isArray(value.notes) && value.notes.length > 0) lines.push(...value.notes);
	return text(lines.join("\n"));
}

/** Render a geo verdict. */
function renderGeo(value) {
	if (value === null || typeof value !== "object") return text(value);
	const ips = Array.isArray(value.resolved_ips) ? value.resolved_ips : [];
	const geo = value.geo ?? null;
	const ping = value.ping ?? null;
	const lines = [
		`${shown(value.host)} → ${shown(value.route)}`,
		`reason: ${shown(value.reason)}`,
		`resolved: ${ips.length === 0 ? "(none)" : ips.join(", ")}`,
		`geo: ${geo === null ? "unavailable" : `${shown(geo.country, "?")} (${shown(geo.country_code, "?")}) via ${shown(geo.provider, "?")}`}${value.geo_source === null || value.geo_source === undefined ? "" : ` [${value.geo_source}]`}`,
		`ping: ${ping === null ? "skipped" : `icmp=${ping.icmp?.ok === true ? `${ping.icmp.time_ms}ms` : "fail"}, tcp=${ping.tcp_443?.ok === true ? `${ping.tcp_443.time_ms}ms` : "fail"}`}`
	];
	if (value.advice !== null && value.advice !== undefined) lines.push(`advice: ${value.advice}`);
	return text(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

/** @param ctx - plugin context. @param config - the row's config (volatile-wrapped). */
function apply(ctx, config) {
	const live = config !== null && typeof config === "object" ? config : {};
	// Re-read on every access: the loader mutates the Volatile containers in
	// place when the management panel writes a field.
	const resolveConfig = () => plain(live);

	const upstream = new UpstreamManager(ctx, resolveConfig, { dataDirName: ENTRY_ID });
	const disposers = [];
	const log = {
		info: (message, ...args) => ctx.logger?.info?.(`dsh-downloader: ${message}`, ...args),
		warn: (message, ...args) => ctx.logger?.warn?.(`dsh-downloader: ${message}`, ...args)
	};

	// ---- settings panel: react to writes without re-mounting the plugin ----
	try {
		ctx.on("loader/volatile-update", () => {
			void upstream.resolve({ refresh: true }).catch((error) => log.warn("reload after a settings change failed: %s", String(error)));
		});
	} catch {
		// The loader event is optional; the panel still persists config.
	}
	// Show our own page instead of an auto-generated one.
	ctx.inject?.(['settings'], (settingsCtx) => {
		try {
			settingsCtx.settings?.configure?.({ auto: false }, ctx.fiber);
		} catch {
			/* the settings service may not implement configure() */
		}
	});
	// Optional interval service: enables subscription auto-update and the
	// periodic latency sweep. Absent => the core still works, just manually.
	ctx.inject?.(['timer'], (timerCtx) => {
		try {
			upstream.attachScheduler((callback, delayMs) => timerCtx.setInterval(callback, delayMs));
		} catch (error) {
			log.warn("could not attach the timer service: %s", String(error));
		}
	});

	// ---- shared state for the tool implementations ----
	const inFlight = new Set();

	/**
	 * Resolve the destination path, enforcing the workspace boundary.
	 * @returns the absolute destination path.
	 */
	function resolveDestination(target, exec) {
		const section = resolveConfig();
		const url = String(target.url ?? "").trim();
		const suggested = filenameFromUrl(url) || "download.bin";
		const configuredDir = typeof section.downloadDir === "string" && section.downloadDir.trim().length > 0
			? section.downloadDir.trim()
			: defaultDownloadDir();
		const raw = typeof target.save_path === "string" ? target.save_path.trim() : "";

		let destination;
		if (raw.length === 0) {
			destination = path.join(configuredDir, suggested);
		} else {
			const absolute = path.resolve(raw);
			const looksLikeDirectory = /[\\/]$/.test(raw) || (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory());
			destination = looksLikeDirectory ? path.join(absolute, suggested) : absolute;
		}

		const allowedRoots = [workspaceRoot(ctx, exec), configuredDir, defaultDownloadDir()];
		const permitted = section.allowOutsideWorkspace === true || allowedRoots.some((root) => isInside(destination, root));
		if (!permitted) {
			throw new Error(
				`refusing to write outside the workspace: ${destination}. Set allowOutsideWorkspace = true in Settings → Download proxy, ` +
					`save under ${configuredDir}, or pass a save_path inside ${workspaceRoot(ctx, exec)}.`
			);
		}
		return destination;
	}

	// ---- dsh_download ------------------------------------------------------
	disposers.push(
		ctx.tools.register({
			name: "dsh_download",
			description:
				"Download a file from the internet to local disk. The plugin decides the route itself: domestic targets go direct, " +
				"foreign targets go through the configured proxy (a self-contained subscription core or an explicit proxy URL), and a failed " +
				"direct attempt is retried through the proxy. Returns the saved path, byte count, sha256, speed, and the route used. " +
				"Prefer this over curl/Invoke-WebRequest for any internet download.",
			parameters: {
				type: "object",
				properties: {
					url: { type: "string", description: "Absolute http:// or https:// download URL." },
					save_path: { type: "string", description: "Destination file, or a directory to place the auto-derived filename in. Defaults to the configured download directory." },
					overwrite: { type: "boolean", description: "Overwrite an existing destination file. Defaults to false." },
					force_route: { type: "string", enum: ["auto", "proxy", "direct"], description: "auto (default) routes by the rule engine; direct/proxy force one path." },
					max_mb: { type: "number", description: "Override the configured per-file size limit for this call." },
					timeout_seconds: { type: "number", description: "Override the configured wall-clock budget for this call." }
				},
				required: ["url"],
				additionalProperties: false
			},
			output: { schema: OBJECT_OUTPUT_SCHEMA, render: (_args, value) => renderDownload(value) },
			isConcurrencySafe: () => true,
			presentCall: (args) => ({ card: "generic", kind: "fetch", title: "Download file", rawInput: String(args?.url ?? "") }),
			presentResult: (args, result) => ({ card: "generic", title: result?.isError === true ? "Download failed" : "Download complete" }),
			execute: async (args, exec) => {
				const section = resolveConfig();
				const url = String(args?.url ?? "").trim();
				if (url.length === 0) throw new Error("url is required");
				const forceRoute = ["auto", "proxy", "direct"].includes(String(args?.force_route ?? "auto")) ? String(args?.force_route ?? "auto") : "auto";

				try {
					const view = await upstream.resolve();
					const warnings = [];
					if (view.mode === "none") warnings.push("no proxy is configured, so no target can be routed through one");
					else if (view.available !== true) warnings.push(`the proxy core is not usable (${view.reason})`);

					const decision = decideRoute(url, view, forceRoute);
					if (decision.warning !== null) warnings.push(decision.warning);

					const destination = resolveDestination(args, exec);
					const maxBytes = Math.max(1, Number(args?.max_mb) > 0 ? Number(args.max_mb) : section.maxDownloadMb) * 1024 * 1024;
					const timeoutS = Number(args?.timeout_seconds) > 0 ? Number(args.timeout_seconds) : section.downloadTimeoutS;

					inFlight.add(destination);
					let result;
					try {
						result = await downloadWithFallback({
							url,
							savePath: destination,
							overwrite: args?.overwrite === true,
							decidedRoute: decision,
							upstream: view,
							forceRoute,
							maxBytes,
							timeoutS,
							stallS: section.stallTimeoutS,
							insecure: section.insecureTls === true,
							maxRedirects: section.maxRedirects,
							signal: exec.signal
						});
					} finally {
						inFlight.delete(destination);
					}

					return {
						ok: true,
						saved_to: result.savedTo,
						bytes: result.bytes,
						sha256: result.sha256,
						speed_bps: result.speedBps,
						elapsed_ms: result.elapsedMs,
						route: result.route,
						route_reason: result.routeReason,
						fallback_used: result.fallbackUsed,
						upstream: { mode: view.mode, node: view.nodeName, node_type: view.nodeType },
						http: result.http,
						final_url: result.finalUrl,
						warnings
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const hint = error instanceof NoUpstreamError ? error.hint : null;
					const view = upstream.view();
					log.warn("download failed: %s", message);
					throw new Error(
						`${message}\n  upstream mode: ${view.mode} — ${view.reason}\n  hint: ${hint ?? "check the URL, the destination path, and Settings → Download proxy"}`
					);
				}
			}
		})
	);

	// ---- dsh_proxy_status --------------------------------------------------
	disposers.push(
		ctx.tools.register({
			name: "dsh_proxy_status",
			description:
				"Report the state of the download proxy: upstream mode, whether the subscription loaded, node count and latencies, the selected node, " +
				"the local rule-core port, and the last error. Use it to diagnose why a download did or did not go through a proxy.",
			parameters: {
				type: "object",
				properties: {
					refresh: { type: "boolean", description: "Force a full re-resolution (re-fetch the subscription, rebuild the rule core)." },
					test_all: { type: "boolean", description: "Also latency-test every node (slow)." },
					include_nodes: { type: "boolean", description: "Include the node list in the result. Defaults to true." }
				},
				additionalProperties: false
			},
			output: { schema: OBJECT_OUTPUT_SCHEMA, render: (_args, value) => renderStatus(value) },
			isConcurrencySafe: () => true,
			presentCall: () => ({ card: "generic", kind: "other", title: "Check download proxy" }),
			presentResult: () => ({ card: "generic", title: "Download proxy status" }),
			execute: async (args) => {
				const view = await upstream.resolve({ refresh: args?.refresh === true });
				if (args?.test_all === true && view.available) await upstream.testAllLatencies();
				const status = upstream.status();
				const notes = [];
				if (status.nativeNodes > 0 && status.nativeConnector !== true) {
					notes.push(`note: ${status.nativeNodes} node(s) need the optional native connector, which is not bundled in this build.`);
				}
				if (status.mode === "none") {
					notes.push("note: set a subscription URL or a proxy URL in Settings → Download proxy to enable proxied downloads.");
				}
				if (status.error !== null && status.error !== undefined) notes.push(`note: ${status.error}`);
				// The tool surface is snake_case; the management API keeps the
				// service's camelCase for the browser panel.
				const payload = {
					state: status.state,
					error: status.error,
					mode: status.mode,
					reason: status.reason,
					enabled: status.enabled,
					port: status.port,
					node_count: status.nodeCount,
					unsupported_nodes: status.unsupportedNodes,
					native_connector: status.nativeConnector,
					native_nodes: status.nativeNodes,
					selected: status.selected,
					group_type: status.groupType,
					domestic_direct: status.domesticDirect,
					subscription_url_set: status.subscriptionUrlSet,
					proxy_url_set: status.proxyUrlSet,
					env_proxy: status.envProxy,
					last_subscription_update: status.lastSubscriptionUpdate,
					latency_test_url: status.latencyTestUrl,
					auto_update_hours: status.autoUpdateHours,
					data_dir: status.dataDir,
					traffic: status.traffic,
					groups: upstream.groups().map((group) => ({ name: group.name, type: group.type, now: group.now, size: group.all.length })),
					notes
				};
				if (args?.include_nodes !== false) {
					payload.nodes = upstream.nodeList().map((node) => ({
						name: node.name,
						type: node.type,
						server: node.server,
						port: node.port,
						delay: node.delay,
						alive: node.alive,
						needs_native: node.needsNative
					}));
				}
				return payload;
			}
		})
	);

	// ---- dsh_geo_check -----------------------------------------------------
	disposers.push(
		ctx.tools.register({
			name: "dsh_geo_check",
			description:
				"Decide whether a URL or host is domestic or foreign and which route the downloader will take. The verdict comes from the embedded " +
				"offline rule tables first (no network at all); DNS, GeoIP, and ping are only consulted when the rule tables cannot decide.",
			parameters: {
				type: "object",
				properties: {
					url_or_host: { type: "string", description: "A URL or a bare hostname / IP literal." },
					ping: { type: "boolean", description: "Also run ICMP + TCP probes. Defaults to true." }
				},
				required: ["url_or_host"],
				additionalProperties: false
			},
			output: { schema: OBJECT_OUTPUT_SCHEMA, render: (_args, value) => renderGeo(value) },
			isConcurrencySafe: () => true,
			presentCall: (args) => ({ card: "generic", kind: "search", title: "Check routing for a host", rawInput: String(args?.url_or_host ?? "") }),
			presentResult: () => ({ card: "generic", title: "Routing verdict" }),
			execute: async (args, exec) => {
				const input = String(args?.url_or_host ?? "").trim();
				if (input.length === 0) throw new Error("url_or_host is required");
				return await geoCheck(input, { ping: args?.ping !== false, upstream, exec });
			}
		})
	);

	// ---- runtime skill -----------------------------------------------------
	ctx.inject?.(['skills'], (skillsCtx) => {
		try {
			disposers.push(
				skillsCtx.skills.register({
					name: "smart-download",
					source: ENTRY_ID,
					whenToUse:
						"Whenever a task needs a file from the internet — installers, GitHub release assets, model weights, datasets, archives, disk images, " +
						"or any large artifact — and whenever someone asks whether a site needs a proxy.",
					description:
						"Download internet files with dsh_download: domestic targets go direct, foreign targets go through the plugin's proxy core " +
						"(self-contained subscription or an explicit proxy URL), a failed direct attempt is retried through the proxy, and the result carries " +
						"a sha256 plus the saved path. Prefer it over curl / Invoke-WebRequest.",
					content: SKILL_CONTENT,
					invocation: { modelInvocable: true, userInvocable: true }
				})
			);
			log.info("registered the smart-download skill");
		} catch (error) {
			log.warn("could not register the smart-download skill: %s", String(error));
		}
	});

	// ---- management panel JSON API ----------------------------------------
	ctx.inject?.(['webServer'], (wsCtx) => {
		try {
			disposers.push(
				wsCtx.webServer.register({
					kind: "prefix",
					path: "/dsh-downloader",
					handler: (req, res) => {
						upstream.handleHttp(req, res).catch((error) => {
							log.warn("management API request failed: %s", String(error));
							if (!res.headersSent) res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
							res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
						});
					}
				})
			);
			log.info("registered /dsh-downloader management API");
		} catch (error) {
			log.warn("could not register the management API route: %s", String(error));
		}
	});

	ctx.on("dispose", () => {
		for (const dispose of disposers.splice(0)) {
			try {
				dispose();
			} catch {
				/* already disposed */
			}
		}
		void upstream.stop();
	});

	log.info("loaded (%d config fields)", CONFIG_KEYS.length);
}

/**
 * Offline-first routing verdict for one target.
 * @param input - URL or bare host.
 * @param options - `{ ping, upstream, exec }`.
 */
async function geoCheck(input, { ping = true, upstream, exec }) {
	let host = input;
	try {
		const url = new URL(input.includes("://") ? input : `http://${input}`);
		host = url.hostname;
	} catch {
		// Treat it as a bare host.
	}
	const literal = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");

	const view = await upstream.resolve();
	let route = "direct";
	let reason = "";
	if (view.engine === null || view.engine === undefined) {
		reason = view.reason ?? "no proxy is configured; downloads go direct";
	} else {
		const decision = view.engine.decide(host);
		route = decision === "reject" ? "reject" : decision;
		reason =
			decision === "direct"
				? `embedded rule tables classify ${host} as domestic/direct`
				: decision === "reject"
					? `the active rules reject ${host}`
					: `embedded rule tables classify ${host} as foreign/proxied`;
	}

	const ips = literal ? [host] : await resolveHost(host);
	const provisional = ips.filter((ip) => !isPrivateIp(ip));
	const allPrivate = ips.length > 0 && provisional.length === 0;

	// Only reach for the network when the offline tables could not decide.
	let geo = null;
	let geoSource = null;
	if (allPrivate && ips.length > 0) {
		geoSource = "private address";
	} else {
		const target = provisional[0] ?? ips[0] ?? null;
		if (target !== null && !literal) {
			geo = await geoLookupIP(target, { timeoutMs: 6000, signal: exec?.signal });
			if (geo !== null) geoSource = `online GeoIP (${geo.provider})`;
		}
	}

	let pingResult = null;
	if (ping && ips.length > 0) {
		const [icmp, tcp] = await Promise.all([icmpPing(host), tcpPing(host, 443)]);
		pingResult = { icmp: { ok: icmp.ok, time_ms: icmp.timeMs }, tcp_443: { ok: tcp.ok, time_ms: tcp.timeMs } };
	}

	let advice;
	if (route === "proxy") {
		advice = view.available ? "Downloads for this host go through the proxy core." : "This host needs the proxy, but no usable node exists — check Settings → Download proxy.";
	} else if (route === "direct") {
		advice = "Downloads for this host go direct; no proxy hop is used.";
	} else {
		advice = "The active rules reject this host; downloads will fail by design.";
	}
	if (allPrivate && !literal) {
		advice += ` The name resolves to ${ips.join(", ")}, which looks like a hosts-file override or DNS pollution.`;
	}

	return {
		input,
		host,
		route,
		reason,
		resolved_ips: ips,
		geo: geo === null ? null : { ip: geo.ip, country: geo.country, country_code: geo.countryCode, isp: geo.isp, provider: geo.provider },
		geo_source: geoSource,
		proxy_available: view.available === true,
		proxy_mode: view.mode,
		ping: pingResult,
		advice
	};
}

/** Body of the registered `smart-download` runtime skill. */
const SKILL_CONTENT = `# Smart download

This plugin registers three tools. Use them instead of shelling out to \`curl\` / \`Invoke-WebRequest\`,
which do not consult the plugin's routing rules.

| Tool | Use it for |
| --- | --- |
| \`dsh_download\` | Downloading any internet file. Routing, size limits, sha256 and retry-on-failure are built in. |
| \`dsh_proxy_status\` | Diagnosing why a download did or did not go through a proxy. |
| \`dsh_geo_check\` | Answering "is this site domestic or foreign, and will it be proxied?". |

## Working rules

1. **Downloading a file → call \`dsh_download\` directly.** Do not run \`dsh_geo_check\` first; the
   download tool already routes by itself. \`dsh_geo_check\` is for answering questions, not for pre-flight.
2. **Never substitute \`curl\` / \`Invoke-WebRequest\`** for an internet download unless the user explicitly
   asks for a shell command. Those bypass the proxy rules entirely.
3. **Routing is automatic and reported.** Read \`route\` and \`route_reason\` from the result:
   - \`direct\` — domestic target, no proxy hop.
   - \`proxy\` — foreign target, fetched through the plugin's node.
   - \`fallback_used: true\` — the direct attempt failed and the proxy was used for the retry.
4. **Report back with facts**: \`saved_to\`, \`bytes\` (render it human-readably), \`sha256\`, \`speed_bps\`.
   Mention the route when it matters to the user.
5. **Size limit errors mean "confirm first".** \`max_mb\` defaults to 512. When the tool reports that the file
   exceeds the limit, tell the user the declared size and ask before raising \`max_mb\`.
6. **No upstream configured.** If \`dsh_download\` fails with "no usable proxy exit", do **not** silently fall
   back to \`curl\`. Tell the user to open **Settings → Download proxy** and set a subscription URL or a proxy URL,
   then retry.
7. **Paused for cancellation.** A cancelled or stalled download never leaves a half-written file behind:
   the partial is always removed. A re-run is always safe.
8. **Large files.** Downloads are not subject to a host tool timeout, but they do respect
   \`download_timeout_s\` (default 600s). For something you expect to take much longer, raise
   \`timeout_seconds\` on the call after confirming with the user.

## Scope caveat (state this when it matters)

This plugin covers **its own downloads only**. \`web_fetch\`, and \`curl\` / \`git\` / \`npm\` run through the
shell tool, are governed by DSH's own launch-time proxy policy (the \`HTTP_PROXY\` / \`HTTPS_PROXY\` entries in
\`$DSH_HOME/.env\`), not by this plugin. If the user needs those routed too, point them at that file.
`;

export { Config, CONFIG_KEYS, ENTRY_ID, SETTINGS_NAMESPACE, apply, inject, name };

/** Renderers and helpers exposed for the offline test suite only. */
export const __internals = { plain, renderDownload, renderGeo, renderStatus, shown };
