/**
 * Upstream resolution: turns the plugin config into "where does proxied
 * traffic leave this machine", and owns the loopback rule core that does it.
 *
 * Three modes, tried in order (`resolve()`):
 * 1. `explicit`     — `config.proxyUrl`
 * 2. `environment`  — `$HTTPS_PROXY` / `$HTTP_PROXY` (the values DSH's own
 *                     launch-time proxy policy publishes into `process.env`)
 * 3. `subscription` — a self-contained Clash subscription (the only mode that
 *                     needs no external program at all)
 *
 * Every mode that has a usable exit starts the *same* loopback mixed proxy
 * (`ProxyServer` + `RuleEngine`), so the downloader has exactly one proxy code
 * path: HTTP CONNECT to `127.0.0.1:<port>`.
 *
 * The plugin never mutates `process.env` and never touches a global dispatcher.
 * @module dsh-downloader/upstream
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fetchSubscription, parseSubscription, sanitizeGroups } from "./subscription.js";
import { RuleEngine } from "./rules.js";
import { ProxyServer } from "./proxy-server.js";
import { hasNativeConnector, measureLatency } from "./transports.js";
import { parseProxyUrl } from "../download/http.js";
import { humanSize } from "../download/util.js";
import { composeDirectDomains, directRuleLines } from "./ai-domains.js";
import { applyGuard, envFilePath, inspectGuard, restoreGuard } from "./session-guard.js";

/** Node types the vendored transports implement. */
const SUPPORTED_TYPES = new Set(["http", "socks5", "socks", "ss", "trojan", "vless", "vmess", "hysteria2"]);

/** Group types surfaced in the management panel. */
const GROUP_TYPES = new Set(["select", "url-test", "fallback", "load-balance"]);

/** Config fields whose change requires rebuilding the core. */
const REBUILD_FIELDS = [
	"enabled",
	"proxyUrl",
	"subscriptionUrl",
	"fetchProxyUrl",
	"groupType",
	"preferredNode",
	"latencyTestUrl",
	"latencyTimeoutMs",
	"domesticDirect",
	"protectAiPlatforms",
	"extraDirectDomains",
	"extraRules",
	"excludeRules"
];

/** True when a parsed node object speaks a protocol the transports implement. */
export function isSupportedNode(node) {
	if (typeof node === "string") return false;
	return SUPPORTED_TYPES.has(String(node?.type ?? "").toLowerCase());
}

/** Whether a node needs the optional bundled Go connector. */
export function needsNativeConnector(node) {
	if (typeof node === "string") return false;
	const type = String(node?.type ?? "").toLowerCase();
	return type === "hysteria2" || (type === "vless" && node?.["reality-opts"] !== undefined) || node?.["reality-opts"] !== undefined;
}

/** Loopback URLs must never be handed to a proxy. */
function isLoopbackUrl(value) {
	try {
		const host = new URL(value.includes("://") ? value : `http://${value}`).hostname.toLowerCase();
		return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
	} catch {
		return false;
	}
}

export class UpstreamManager {
	#ctx;
	#resolveConfig;
	#dataDirName;

	#state = "idle";
	#error = null;
	#mode = "none";
	#reason = "尚未解析";
	#signature = null;

	#server = null;
	#port = 0;
	#engine = null;
	/** @type {Map<string, object>} */
	#nodes = new Map();
	#unsupported = 0;
	#nativeNodes = 0;
	#selected = null;
	/** @type {Record<string, number|null>} */
	#latencies = {};
	#subscription = null;
	#traffic = { up: 0, down: 0, at: 0 };
	#autoUpdateDisposer = null;
	#latencyDisposer = null;
	#scheduler = null;
	#task = Promise.resolve();

	constructor(ctx, resolveConfig, options = {}) {
		this.#ctx = ctx;
		this.#resolveConfig = resolveConfig;
		this.#dataDirName = options.dataDirName ?? "dsh-downloader";
	}

	/** Data directory (`$DSH_HOME/<name>`). */
	get dataDir() {
		const root = process.env.DSH_HOME ?? join(homedir(), ".dsh");
		return join(root, this.#dataDirName);
	}

	/** Bound loopback port of the rule core (0 when not running). */
	get port() {
		return this.#port;
	}

	// ---- public API ---------------------------------------------------------

	/**
	 * Resolve the upstream for the current config. Cheap after the first call:
	 * the core is rebuilt only when a rebuild-relevant field changed.
	 * @returns the routing view consumed by `decideRoute` and the download tool.
	 */
	async resolve({ refresh = false } = {}) {
		const config = this.#resolveConfig();
		const signature = JSON.stringify(Object.fromEntries(REBUILD_FIELDS.map((field) => [field, config[field]])));
		if (refresh || signature !== this.#signature) {
			this.#signature = signature;
			await this.#rebuild(config, refresh);
		}
		return this.#view();
	}

	/** The current routing view without triggering a rebuild. */
	view() {
		return this.#view();
	}

	/** Live status for the management panel (never includes secrets). */
	status() {
		const config = this.#resolveConfig();
		const protectedDomains = this.directDomains();
		return {
			state: this.#state,
			error: this.#error,
			mode: this.#mode,
			reason: this.#reason,
			enabled: config.enabled !== false,
			port: this.#port,
			nodeCount: this.#nodes.size,
			unsupportedNodes: this.#unsupported,
			nativeConnector: hasNativeConnector(),
			nativeNodes: this.#nativeNodes,
			selected: this.#selected,
			groupType: config.groupType,
			domesticDirect: config.domesticDirect !== false,
			protectAiPlatforms: config.protectAiPlatforms !== false,
			protectedDomains,
			subscriptionUrlSet: typeof config.subscriptionUrl === "string" && config.subscriptionUrl.trim().length > 0,
			proxyUrlSet: typeof config.proxyUrl === "string" && config.proxyUrl.trim().length > 0,
			envProxy: this.#environmentProxy()?.raw ?? null,
			lastSubscriptionUpdate: this.#subscription?.updatedAt ?? null,
			latencyTestUrl: config.latencyTestUrl,
			autoUpdateHours: config.autoUpdateHours,
			dataDir: this.dataDir,
			traffic: this.#server === null ? { up: 0, down: 0, upRate: 0, downRate: 0 } : this.#trafficSnapshot()
		};
	}

	/** The domains currently pinned to DIRECT (AI platforms + user additions). */
	directDomains() {
		const config = this.#resolveConfig();
		return composeDirectDomains({
			protectAiPlatforms: config.protectAiPlatforms !== false,
			extraDirectDomains: config.extraDirectDomains ?? []
		});
	}

	/** Whether `$DSH_HOME/.env` already keeps those domains off the global proxy. */
	guardState() {
		return inspectGuard({ envPath: envFilePath(process.env.DSH_HOME), domains: this.directDomains() });
	}

	/** Proxy groups for the panel (subscription groups plus a synthesized AUTO). */
	groups() {
		const config = this.#resolveConfig();
		const parsed = this.#subscription?.parsed;
		if (parsed === null || parsed === undefined) return [];
		const names = parsed.names;
		const groups = sanitizeGroups(parsed.groups, names).filter((group) => GROUP_TYPES.has(group.type));
		if (!groups.some((group) => group.name === "AUTO") && names.length > 0) {
			groups.unshift({ name: "AUTO", type: config.groupType, proxies: names });
		}
		return groups.map((group) => ({
			name: group.name,
			type: group.type,
			now: group.name === "AUTO" ? this.#currentNodeName() : group.now ?? group.proxies?.[0] ?? null,
			all: group.proxies
		}));
	}

	/** Every parsed node with its latency and whether the transports support it. */
	nodeList() {
		return [...this.#nodes.entries()].map(([name, node]) => ({
			name,
			type: typeof node === "string" ? "uri" : node.type,
			server: typeof node === "string" ? null : node.server ?? null,
			port: typeof node === "string" ? null : node.port ?? null,
			delay: this.#latencies[name] ?? null,
			alive: this.#latencies[name] === undefined ? null : this.#latencies[name] !== null,
			needsNative: needsNativeConnector(node)
		}));
	}

	/** Persist a manual node selection and refresh the core's resolver. */
	async selectNode(name) {
		if (!this.#nodes.has(name)) throw new Error(`未知节点：${name}`);
		this.#selected = name;
		await this.#saveState();
	}

	/** One latency test, for the panel. */
	async testLatency(name) {
		const node = this.#nodes.get(name);
		if (node === undefined) throw new Error(`未知节点：${name}`);
		const delay = await this.#testOne(node);
		this.#latencies[name] = delay;
		return delay;
	}

	/** Latency-test every node with bounded concurrency (in-memory only). */
	async testAllLatencies(names, concurrency = 8) {
		const list = (names ?? [...this.#nodes.keys()]).filter((name) => this.#nodes.has(name));
		const results = {};
		let cursor = 0;
		const worker = async () => {
			for (;;) {
				const index = cursor;
				cursor += 1;
				if (index >= list.length) return;
				const name = list[index];
				results[name] = await this.#testOne(this.#nodes.get(name));
				this.#latencies[name] = results[name];
			}
		};
		await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length || 1)) }, worker));
		return results;
	}

	/** Drop cached latencies (fresh panel load). */
	clearLatencies() {
		this.#latencies = {};
	}

	/** Re-fetch the subscription and rebuild the core. */
	updateSubscription(refresh = true) {
		return this.#queue(async () => {
			const config = this.#resolveConfig();
			await this.#rebuild(config, refresh, true);
			if (this.#nodes.size > 0) void this.testAllLatencies().catch(() => {});
		});
	}

	/** Tear everything down: timers, listener, state. */
	stop() {
		return this.#queue(async () => {
			this.#disposeTimers();
			this.#server?.stop();
			this.#server = null;
			this.#engine = null;
			this.#port = 0;
			this.#nodes = new Map();
			this.#unsupported = 0;
			this.#nativeNodes = 0;
			this.#latencies = {};
			this.#mode = "none";
			this.#reason = "已停止";
			this.#state = "idle";
			this.#signature = null;
		});
	}

	// ---- HTTP API for the management panel ----------------------------------

	/** Route one request from the DSH webserver under `/dsh-downloader`. */
	async handleHttp(req, res) {
		const url = new URL(req.url ?? "/", "http://localhost");
		const sub = url.pathname.slice("/dsh-downloader".length).replace(/^\/+/, "");
		const method = (req.method ?? "GET").toUpperCase();
		const send = (status, payload) => {
			if (res.headersSent) return;
			const body = JSON.stringify(payload);
			res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
			res.end(body);
		};
		const readJson = () =>
			new Promise((resolve, reject) => {
				const chunks = [];
				let size = 0;
				req.on("data", (chunk) => {
					size += chunk.length;
					if (size > 1024 * 1024) {
						reject(new Error("请求体过大"));
						req.destroy();
						return;
					}
					chunks.push(chunk);
				});
				req.on("end", () => {
					try {
						resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
					} catch {
						resolve({});
					}
				});
				req.on("error", reject);
			});

		try {
			switch (sub) {
				case "status": {
					if (url.searchParams.get("refresh") === "1") await this.resolve({ refresh: true });
					return send(200, this.status());
				}
				case "proxies": {
					if (url.searchParams.get("refresh") === "1") await this.resolve({ refresh: true });
					return send(200, { groups: this.groups(), nodes: this.nodeList() });
				}
				case "restart": {
					if (method !== "POST") return send(405, { error: "该接口仅支持 POST" });
					await this.resolve({ refresh: true });
					return send(200, this.status());
				}
				case "update-subscription": {
					if (method !== "POST") return send(405, { error: "该接口仅支持 POST" });
					await this.updateSubscription(true);
					return send(200, this.status());
				}
				case "delay": {
					if (method !== "POST") return send(405, { error: "该接口仅支持 POST" });
					const body = await readJson();
					if (typeof body.name !== "string") return send(400, { error: "缺少 name 参数" });
					return send(200, { name: body.name, delay: await this.testLatency(body.name) });
				}
				case "delay-all": {
					if (method !== "POST") return send(405, { error: "该接口仅支持 POST" });
					await this.resolve();
					const body = await readJson();
					const names = Array.isArray(body.names) && body.names.length > 0 ? body.names.filter((name) => typeof name === "string") : undefined;
					return send(200, { results: await this.testAllLatencies(names) });
				}
				case "clear-latencies": {
					if (method !== "POST") return send(405, { error: "该接口仅支持 POST" });
					this.clearLatencies();
					return send(200, { ok: true });
				}
				case "select": {
					if (method !== "POST") return send(405, { error: "该接口仅支持 POST" });
					const body = await readJson();
					if (typeof body.name !== "string") return send(400, { error: "缺少 name 参数" });
					await this.selectNode(body.name);
					return send(200, { ok: true, selected: body.name });
				}
				case "traffic":
					return send(200, this.#trafficSnapshot());
				case "guard":
					return send(200, this.guardState());
				case "guard-apply": {
					if (method !== "POST") return send(405, { error: "该接口仅支持 POST" });
					return send(200, { ...applyGuard({ envPath: envFilePath(process.env.DSH_HOME), domains: this.directDomains() }), state: this.guardState() });
				}
				case "guard-restore": {
					if (method !== "POST") return send(405, { error: "该接口仅支持 POST" });
					return send(200, { ...restoreGuard({ envPath: envFilePath(process.env.DSH_HOME) }), state: this.guardState() });
				}
				default:
					return send(404, { error: `未知接口：${sub}` });
			}
		} catch (error) {
			send(500, { error: error instanceof Error ? error.message : String(error) });
		}
	}

	// ---- internals ----------------------------------------------------------

	#queue(operation) {
		const task = this.#task.then(operation, operation);
		this.#task = task.catch(() => {});
		return task;
	}

	#view() {
		const config = this.#resolveConfig();
		const disabled = config.enabled === false;
		return {
			mode: disabled ? "none" : this.#mode,
			reason: disabled ? "插件已在设置里关闭" : this.#reason,
			engine: disabled ? null : this.#engine,
			available: !disabled && this.#port > 0 && this.#nodes.size > 0,
			proxy: this.#port > 0 ? { socks: false, host: "127.0.0.1", port: this.#port, raw: `http://127.0.0.1:${this.#port}` } : null,
			corePort: this.#port,
			nodeName: this.#currentNodeName(),
			nodeType: (() => {
				const name = this.#currentNodeName();
				if (name === null) return null;
				const node = this.#nodes.get(name);
				return node === undefined ? null : typeof node === "string" ? "uri" : node.type ?? null;
			})(),
			subscriptionRules: this.#subscription?.parsed?.rules?.length ?? 0
		};
	}

	/** The proxy named by the ambient environment, if any (never loopback). */
	#environmentProxy() {
		for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
			const value = process.env[name];
			if (typeof value !== "string" || value.trim().length === 0) continue;
			if (isLoopbackUrl(value)) continue;
			const parsed = parseProxyUrl(value);
			if (parsed !== null) return parsed;
		}
		return null;
	}

	/** Proxy used to fetch the subscription itself. */
	#resolveFetchProxy(config) {
		const candidates = [config.fetchProxyUrl, config.proxyUrl, this.#environmentProxy()?.raw];
		for (const candidate of candidates) {
			if (typeof candidate !== "string" || candidate.trim().length === 0) continue;
			const parsed = parseProxyUrl(candidate);
			if (parsed === null || parsed.socks === true) continue;
			return parsed;
		}
		return null;
	}

	#buildEngine(config, subscriptionRules) {
		// Domestic AI platforms are pinned to DIRECT ahead of everything else, so
		// a flapping node can never take a model endpoint down — not even in
		// "everything through the proxy" mode.
		const protection = directRuleLines(
			composeDirectDomains({
				protectAiPlatforms: config.protectAiPlatforms !== false,
				extraDirectDomains: config.extraDirectDomains ?? []
			})
		);
		if (config.domesticDirect === false) {
			if (protection.length === 0) return { decide: () => "proxy" };
			return new RuleEngine({ extraRules: [...protection, "MATCH,PROXY"], subscriptionRules: [] });
		}
		return new RuleEngine({
			extraRules: [...protection, ...(config.extraRules ?? [])],
			excludeRules: config.excludeRules ?? [],
			subscriptionRules: subscriptionRules ?? []
		});
	}

	/** Rebuild mode + core for the current config. */
	async #rebuild(config, refresh, forceSubscriptionReload = false) {
		this.#disposeTimers();
		this.#server?.stop();
		this.#server = null;
		this.#engine = null;
		this.#port = 0;
		this.#nodes = new Map();
		this.#unsupported = 0;
		this.#nativeNodes = 0;
		this.#error = null;

		if (config.enabled === false) {
			this.#mode = "none";
			this.#reason = "插件已在设置里关闭";
			this.#state = "disabled";
			return;
		}

		const explicitRaw = typeof config.proxyUrl === "string" ? config.proxyUrl.trim() : "";
		const envProxy = this.#environmentProxy();

		if (explicitRaw.length > 0 || envProxy !== null) {
			const fromConfig = explicitRaw.length > 0;
			const parsed = fromConfig ? parseProxyUrl(explicitRaw) : envProxy;
			if (parsed === null) {
				this.#mode = "explicit";
				this.#reason = `proxyUrl 不是可用的 http(s) / socks5 代理地址：${explicitRaw}`;
				this.#state = "failed";
				this.#error = this.#reason;
				return;
			}
			this.#mode = fromConfig ? "explicit" : "environment";
			this.#reason = fromConfig
				? `使用配置的 proxyUrl（${parsed.host}:${parsed.port}）`
				: `使用 DSH 启动环境发布的代理（${parsed.host}:${parsed.port}）`;
			const credentials = parsed.auth === null || parsed.auth === undefined
				? {}
				: { username: parsed.auth.username, password: parsed.auth.password };
			const node = parsed.socks === true
				? { name: "configured-proxy", type: "socks5", server: parsed.host, port: parsed.port, ...credentials }
				: { name: "configured-proxy", type: "http", server: parsed.host, port: parsed.port, ...credentials };
			this.#nodes = new Map([[node.name, node]]);
			this.#engine = this.#buildEngine(config, []);
			await this.#startCore();
			return;
		}

		const subscriptionUrl = typeof config.subscriptionUrl === "string" ? config.subscriptionUrl.trim() : "";
		if (subscriptionUrl.length === 0) {
			this.#mode = "none";
			this.#reason = "既没有配置 proxyUrl，也没有配置订阅地址";
			this.#state = "no-subscription";
			return;
		}

		this.#mode = "subscription";
		await this.#loadSubscription(config, forceSubscriptionReload || refresh);
		if (this.#subscription === null) {
			this.#reason = "没有可用的订阅（抓取失败且本地没有缓存）";
			this.#state = "no-subscription";
			return;
		}

		const parsed = this.#subscription.parsed;
		const supported = [];
		for (const node of parsed.proxies) {
			const name = typeof node === "string" ? node : node?.name;
			if (typeof name !== "string" || name.length === 0) continue;
			if (!isSupportedNode(node)) {
				this.#unsupported += 1;
				continue;
			}
			if (needsNativeConnector(node)) {
				this.#nativeNodes += 1;
				if (!hasNativeConnector()) {
					this.#unsupported += 1;
					continue;
				}
			}
			supported.push([name, node]);
		}
		this.#nodes = new Map(supported);
		this.#engine = this.#buildEngine(config, parsed.rules);

		if (this.#nodes.size === 0) {
			this.#reason = `订阅已解析，但没有可用节点（${this.#unsupported} 个不受支持）`;
			this.#state = "no-subscription";
			return;
		}

		await this.#loadState();
		await this.#startCore();
		if (this.#state === "running") {
			const parts = [`${this.#nodes.size} 个节点就绪`];
			if (this.#unsupported > 0) parts.push(`${this.#unsupported} 个因不受支持被跳过`);
			this.#reason = `${parts.join("；")}；订阅规则 ${parsed.rules.length} 条`;
		}
	}

	/** Start the loopback rule core and its timers. */
	async #startCore() {
		try {
			this.#server = new ProxyServer({ engine: this.#engine, resolveNode: () => this.#currentNode() });
			this.#port = await this.#server.start(0);
			this.#state = "running";
			this.#scheduleTimers(this.#resolveConfig());
			this.#ctx.logger?.info?.("dsh-downloader: rule core listening on 127.0.0.1:%d (%s)", this.#port, this.#mode);
		} catch (error) {
			this.#state = "failed";
			this.#error = error instanceof Error ? error.message : String(error);
			this.#reason = this.#error;
			this.#server?.stop();
			this.#server = null;
			this.#port = 0;
			this.#ctx.logger?.warn?.("dsh-downloader: rule core failed to start: %s", this.#error);
		}
	}

	#scheduleTimers(config) {
		// The scheduler comes from the optional `timer` service. Without it the
		// core still works, it just never auto-updates the subscription or
		// re-tests latencies.
		const schedule = this.#scheduler;
		if (schedule === null) return;
		const hours = Number(config.autoUpdateHours ?? 0);
		if (Number.isFinite(hours) && hours > 0 && this.#mode === "subscription") {
			this.#autoUpdateDisposer = schedule(() => {
				void this.updateSubscription(true).catch((error) => {
					this.#ctx.logger?.warn?.("dsh-downloader: subscription auto-update failed: %s", String(error));
				});
			}, hours * 3600 * 1000);
		}
		if (config.groupType === "url-test" && this.#nodes.size > 0) {
			this.#latencyDisposer = schedule(() => {
				void this.testAllLatencies().catch(() => {});
			}, 300 * 1000);
		}
	}

	/**
	 * Attach the host's interval scheduler (from the optional `timer` service).
	 * Safe to call before or after `resolve()`; timers are (re)armed either way.
	 * @param schedule - `(callback, delayMs) => disposer`.
	 */
	attachScheduler(schedule) {
		this.#scheduler = typeof schedule === "function" ? schedule : null;
		if (this.#state === "running") {
			this.#disposeTimers();
			this.#scheduleTimers(this.#resolveConfig());
		}
	}

	#disposeTimers() {
		this.#autoUpdateDisposer?.();
		this.#autoUpdateDisposer = null;
		this.#latencyDisposer?.();
		this.#latencyDisposer = null;
	}

	/** Load the subscription body from the URL or the cached copy. */
	async #loadSubscription(config, force) {
		const cachePath = join(this.dataDir, "subscription.yaml");
		const metaPath = join(this.dataDir, "subscription.meta.json");
		const url = typeof config.subscriptionUrl === "string" ? config.subscriptionUrl.trim() : "";

		if (!force && this.#subscription !== null) return;

		let fetchError = null;
		if (url.length > 0) {
			try {
				const raw = await fetchSubscription(url, config.fetchProxyUrl ?? "", 30000);
				await mkdir(this.dataDir, { recursive: true });
				await writeFile(cachePath, raw, "utf8");
				await writeFile(metaPath, JSON.stringify({ at: Date.now(), url }), "utf8");
				this.#subscription = { raw, updatedAt: Date.now(), parsed: parseSubscription(raw), stale: false };
				this.#ctx.logger?.info?.("dsh-downloader: subscription updated (%d nodes)", this.#subscription.parsed.names.length);
				return;
			} catch (error) {
				fetchError = error;
			}
		}

		const cached = await readFile(cachePath, "utf8").catch(() => null);
		if (cached === null || cached.trim().length === 0) {
			this.#subscription = null;
			if (fetchError !== null) {
				this.#error = fetchError instanceof Error ? fetchError.message : String(fetchError);
				this.#ctx.logger?.warn?.("dsh-downloader: subscription fetch failed and no cache exists: %s", this.#error);
			}
			return;
		}
		const meta = await readFile(metaPath, "utf8")
			.then((text) => JSON.parse(text))
			.catch(() => null);
		try {
			this.#subscription = { raw: cached, updatedAt: meta?.at ?? null, parsed: parseSubscription(cached), stale: fetchError !== null };
		} catch (error) {
			this.#subscription = null;
			this.#error = error instanceof Error ? error.message : String(error);
			return;
		}
		if (fetchError !== null) {
			this.#error = `订阅抓取失败（${fetchError instanceof Error ? fetchError.message : String(fetchError)}），改用本地缓存`;
			this.#ctx.logger?.warn?.("dsh-downloader: %s", this.#error);
		}
	}

	async #saveState() {
		try {
			await mkdir(this.dataDir, { recursive: true });
			await writeFile(join(this.dataDir, "state.json"), JSON.stringify({ selected: this.#selected }, null, 2), "utf8");
		} catch {
			// Non-fatal: selection simply will not survive the next restart.
		}
	}

	async #loadState() {
		try {
			const state = JSON.parse(await readFile(join(this.dataDir, "state.json"), "utf8"));
			if (typeof state.selected === "string" && this.#nodes.has(state.selected)) this.#selected = state.selected;
		} catch {
			// First run.
		}
	}

	/** The node that currently answers proxied traffic. */
	#currentNode() {
		const name = this.#currentNodeName();
		return name === null ? null : this.#nodes.get(name) ?? null;
	}

	#currentNodeName() {
		const config = this.#resolveConfig();
		const preferred = typeof config.preferredNode === "string" ? config.preferredNode.trim() : "";
		if (preferred.length > 0 && this.#nodes.has(preferred)) return preferred;
		if (this.#selected !== null && this.#nodes.has(this.#selected)) return this.#selected;
		const names = [...this.#nodes.keys()];
		if (names.length === 0) return null;
		if (config.groupType === "url-test") {
			let best = null;
			let bestDelay = Infinity;
			for (const name of names) {
				const delay = this.#latencies[name];
				if (typeof delay === "number" && delay < bestDelay) {
					best = name;
					bestDelay = delay;
				}
			}
			if (best !== null) return best;
		}
		return names[0];
	}

	#latencyTarget() {
		const config = this.#resolveConfig();
		try {
			const url = new URL(config.latencyTestUrl ?? "http://www.gstatic.com/generate_204");
			return { host: url.hostname, port: Number(url.port) || (url.protocol === "http:" ? 80 : 443) };
		} catch {
			return { host: "www.gstatic.com", port: 80 };
		}
	}

	async #testOne(node) {
		if (node === undefined) return null;
		const config = this.#resolveConfig();
		const { host, port } = this.#latencyTarget();
		return measureLatency(node, host, port, config.latencyTimeoutMs ?? 3000);
	}

	#trafficSnapshot() {
		const up = this.#server?.counters.up ?? 0;
		const down = this.#server?.counters.down ?? 0;
		const now = Date.now();
		const seconds = Math.max(0.001, (now - this.#traffic.at) / 1000);
		const upRate = Math.max(0, up - this.#traffic.up) / seconds;
		const downRate = Math.max(0, down - this.#traffic.down) / seconds;
		this.#traffic = { up, down, at: now };
		return { up, down, upRate, downRate, total: humanSize(up + down) };
	}
}
