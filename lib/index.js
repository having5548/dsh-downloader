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
import { AI_DIRECT_DOMAINS, composeDirectDomains, normalizeDomain } from "./core/ai-domains.js";
import { applyGuard, envFilePath, inspectGuard, restoreGuard } from "./core/session-guard.js";
import { buildShellPrefix, classifyShellCommand, explainShellRouting } from "./core/shell-proxy.js";
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
	"protectAiPlatforms",
	"extraDirectDomains",
	"guardShellDownloads",
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
	enabled: z.boolean().default(true).description("总开关：关闭后下载工具直接失败，不再解析上游").volatile(),
	proxyUrl: z.string().role("secret").default("").description("显式上游代理，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080").volatile(),
	subscriptionUrl: z.string().role("secret").default("").description("Clash 订阅地址：自包含内核从这里取节点，不需要本机装 Clash").volatile(),
	fetchProxyUrl: z.string().role("secret").default("").description("只用于抓订阅本身的可选 http(s) 代理（订阅被墙时填）").volatile(),
	autoUpdateHours: z.number().step(1).min(0).default(24).description("订阅自动更新间隔（小时，0 = 关闭）").volatile(),
	groupType: z.union([z.const("url-test"), z.const("select"), z.const("fallback")]).default("url-test").description("节点选择策略：自动最快 / 手动 / 失败切换").volatile(),
	preferredNode: z.string().default("").description("按名字固定一个节点（优先级高于上面的策略）").volatile(),
	latencyTestUrl: z.string().default("http://www.gstatic.com/generate_204").description("节点健康检查与测速用的网址").volatile(),
	latencyTimeoutMs: z.number().step(100).min(500).max(10000).default(3000).description("单节点测速超时（毫秒）").volatile(),
	domesticDirect: z.boolean().default(true).description("开启后境内直连、只有境外走代理；关闭则所有下载都走代理（AI 平台仍直连）").volatile(),
	protectAiPlatforms: z.boolean().default(true).description("国内 AI 平台域名强制直连，优先级最高 —— 代理节点抖动或代理程序关闭都不会打断模型连接").volatile(),
	extraDirectDomains: z.array(z.string()).default([]).description("额外强制直连的域名（可填裸域名或完整 URL）").volatile(),
	guardShellDownloads: z.boolean().default(true).description("检测到 git / curl 等 shell 命令要从境外下载时拦下来，改走本插件的代理（可用 dsh_run_proxied 重跑）").volatile(),
	extraRules: z.array(z.string()).default([]).description('追加规则行，如 "DOMAIN-SUFFIX,example.com,DIRECT"').volatile(),
	excludeRules: z.array(z.string()).default([]).description("从订阅规则里剔除的行（子串匹配）").volatile(),
	downloadDir: z.string().default("").description("默认下载目录（留空 = $DSH_HOME/downloads）").volatile(),
	maxDownloadMb: z.number().min(1).default(512).description("单文件大小上限（MB）").volatile(),
	downloadTimeoutS: z.number().min(1).default(600).description("单次下载的总时长预算（秒）").volatile(),
	stallTimeoutS: z.number().min(5).default(30).description("多少秒收不到数据就判定卡死并中止").volatile(),
	insecureTls: z.boolean().default(false).description("跳过 TLS 证书校验（仅企业 TLS 解密环境需要）").volatile(),
	allowOutsideWorkspace: z.boolean().default(false).description("允许 save_path 写到工作区与配置的下载目录之外").volatile(),
	maxRedirects: z.number().step(1).min(0).max(30).default(10).description("最多跟随多少次重定向").volatile()
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
function shown(value, fallback = "（未知）") {
	if (value === null || value === undefined) return fallback;
	if (typeof value === "number" && !Number.isFinite(value)) return fallback;
	return value;
}

/** Render one download result as a compact, quotable report. */
function renderDownload(value) {
	if (value === null || typeof value !== "object") return text(value);
	const lines = [];
	if (value.ok !== true) {
		lines.push(`下载失败：${shown(value.error, "未知错误")}`);
		if (value.hint !== null && value.hint !== undefined) lines.push(`建议：${value.hint}`);
		return text(lines.join("\n"));
	}
	lines.push(`已下载 ${humanSize(value.bytes ?? 0)}，耗时 ${(((value.elapsed_ms ?? 0) / 1000)).toFixed(1)} 秒（${humanSize(value.speed_bps ?? 0)}/s）`);
	lines.push(`保存到：${shown(value.saved_to)}`);
	lines.push(`路由：${routeLabel(value.route)} —— ${shown(value.route_reason)}`);
	if (value.fallback_used === true) lines.push("说明：直连失败，已改用代理重试并成功");
	if (value.upstream !== null && value.upstream !== undefined) {
		lines.push(
			`上游：${modeLabel(value.upstream.mode)}${value.upstream.node === null || value.upstream.node === undefined ? "" : `，节点=${value.upstream.node}（${shown(value.upstream.node_type)}）`}`
		);
	}
	lines.push(`sha256：${shown(value.sha256)}`);
	const http = value.http ?? {};
	const declared = http.content_length;
	const declaredText = typeof declared === "number" && Number.isFinite(declared) ? `，声明大小 ${humanSize(declared)}` : "";
	lines.push(`HTTP：${shown(http.status)}${http.redirects > 0 ? `，经过 ${http.redirects} 次重定向` : ""}${declaredText}`);
	if (Array.isArray(value.warnings) && value.warnings.length > 0) lines.push(`提醒：${value.warnings.join("；")}`);
	return text(lines.join("\n"));
}

/** Chinese label for a route value. */
function routeLabel(route) {
	if (route === "proxy") return "proxy（走代理）";
	if (route === "direct") return "direct（直连）";
	return shown(route);
}

/** Chinese label for a state value. */
function stateLabel(state) {
	switch (state) {
		case "running":
			return "running（运行中）";
		case "disabled":
			return "disabled（已关闭）";
		case "no-subscription":
			return "no-subscription（无可用订阅）";
		case "failed":
			return "failed（失败）";
		case "idle":
			return "idle（未启动）";
		default:
			return shown(state);
	}
}

/** Chinese label for an upstream mode value. */
function modeLabel(mode) {
	switch (mode) {
		case "explicit":
			return "explicit（配置的 proxyUrl）";
		case "environment":
			return "environment（启动环境代理）";
		case "subscription":
			return "subscription（自包含订阅）";
		case "none":
			return "none（未配置）";
		default:
			return shown(mode);
	}
}

/** Chinese label for a session-guard action value. */
function actionLabel(action) {
	switch (action) {
		case "check":
			return "check（只读检查）";
		case "apply":
			return "apply（写入 NO_PROXY）";
		case "restore":
			return "restore（从备份还原）";
		default:
			return shown(action);
	}
}

/** 渲染一份配置的流量/到期信息。 */
function trafficText(info) {
	if (info === null || info === undefined) return "";
	if (!info.total && !info.expire) return "";
	const used = (info.upload ?? 0) + (info.download ?? 0);
	const parts = [];
	if (info.total) parts.push(`已用 ${humanSize(used)} / ${humanSize(info.total)}`);
	if (info.expire) parts.push(`到期 ${new Date(info.expire * 1000).toLocaleDateString()}`);
	return parts.length === 0 ? "" : `（${parts.join("，")}）`;
}

/** 渲染 `dsh_run_proxied` 的结果。 */
function renderProxiedRun(value) {
	if (value === null || typeof value !== "object") return text(value);
	const lines = [value.executed === true ? "已通过本插件的代理执行这条命令。" : "已生成带代理的命令（未执行）。"];
	if (value.command) lines.push(`命令：${value.command}`);
	if (value.executed === true) {
		const output = typeof value.output === "string" ? value.output.trim() : "";
		lines.push(output.length > 0 ? `输出：\n${output}` : "（命令没有任何输出）");
	}
	lines.push("说明：代理只作用于这一次 shell 调用；国内目标仍由插件内核判定直连，国内 AI 平台域名直接绕过。");
	if (value.exit_note) lines.push(value.exit_note);
	return text(lines.join("\n"));
}

/** 渲染 `dsh_profile` 的配置列表。 */
function renderProfiles(value) {
	if (value === null || typeof value !== "object") return text(value);
	const list = Array.isArray(value.profiles) ? value.profiles : [];
	const lines = [`动作：${shown(value.action)}`];
	if (list.length === 0) {
		lines.push("还没有导入任何配置。");
	} else {
		lines.push(`共 ${list.length} 份配置，当前使用：${shown(value.current_label, "无")}`);
		for (const profile of list) {
			const marks = [profile.current ? "当前" : null, profile.source === "file" ? "本地文件" : null].filter(Boolean);
			const auto = profile.source === "file"
				? "本地文件不自动更新"
				: profile.auto_update === true
					? `每 ${profile.auto_update_hours} 小时自动更新`
					: "自动更新已关闭";
			// 只有当前使用的配置才实际解析过，其余不报节点数。
			const nodes = profile.current === true && typeof profile.node_count === "number" ? `${profile.node_count} 个节点，` : "";
			lines.push(
				`  - ${profile.label}${marks.length > 0 ? `（${marks.join("、")}）` : ""}：${nodes}${auto}，` +
					`上次更新 ${profile.last_update_at ? new Date(profile.last_update_at).toLocaleString() : "从未"}` +
					`${trafficText(profile.subscription_info)}`
			);
		}
	}
	if (Array.isArray(value.notes) && value.notes.length > 0) lines.push(...value.notes);
	return text(lines.join("\n"));
}

/** One-line summary of the `$DSH_HOME/.env` session guard. */
function guardLine(guard) {
	if (guard === null || guard === undefined || typeof guard !== "object") return "未知";
	if (guard.covered === true) {
		return guard.exists === true
			? "$DSH_HOME/.env 已让所有 AI 平台域名绕过全局代理"
			: "没有配置全局代理，无需绕过";
	}
	const missing = Array.isArray(guard.missing) ? guard.missing.length : 0;
	return `$DSH_HOME/.env 的 NO_PROXY 还缺 ${missing} 个 AI 平台域名 —— 用 dsh_session_guard 的 action="apply" 补上`;
}

/** Render the status object as readable lines (the raw JSON stays in `value`). */
function renderStatus(value) {
	if (value === null || typeof value !== "object") return text(value);
	const lines = [
		`状态：${stateLabel(value.state)}`,
		`上游模式：${modeLabel(value.mode)} —— ${shown(value.reason)}`,
		`规则内核：${value.port > 0 ? `127.0.0.1:${value.port}` : "未运行"}`,
		`节点数：${shown(value.node_count, 0)}${value.unsupported_nodes > 0 ? `（另有 ${value.unsupported_nodes} 个不受支持）` : ""}`,
		`当前节点：${shown(value.selected, "（自动选择）")}`,
		`境内外分流：${value.domestic_direct === false ? "关闭（全部走代理）" : "开启（境内直连）"}`,
		`AI 平台强制直连：${value.ai_protected === false ? "已关闭" : `开启（${shown(value.ai_direct_domain_count, 0)} 个域名）`}`,
		`会话保护：${guardLine(value.session_guard)}`,
		`代理作用域：${value.scope?.loopbackOnly === true ? "仅 127.0.0.1 回环" : "未知"}${value.scope?.tokenGated === true ? " + 本进程令牌鉴权（其它程序借不走，一律被拒）" : ""}`,
		`节点配置：${value.profile_count > 0 ? `${value.profile_count} 份，当前「${shown(value.current_profile?.label)}」` : value.subscription_url_set === true ? "使用旧版单条订阅地址" : "未配置"}`,
		`原生连接器：${value.native_connector === true ? "已内置" : "未内置（hysteria2 / reality 节点会被跳过）"}`
	];
	if (value.profile_count > 0) {
		lines.push(`旧版单条订阅地址：${value.subscription_url_set === true ? "已填（当前不生效，被上面的配置覆盖）" : "未填"}`);
	} else {
		lines.push(`旧版单条订阅地址：${value.subscription_url_set === true ? "已填" : "未填"} | proxyUrl：${value.proxy_url_set === true ? "已填" : "未填"} | 启动环境代理：${shown(value.env_proxy, "无")}`);
	}
	if (value.last_subscription_update) lines.push(`订阅更新时间：${new Date(value.last_subscription_update).toLocaleString()}`);
	if (value.error !== null && value.error !== undefined) lines.push(`最近错误：${value.error}`);
	if (Array.isArray(value.nodes) && value.nodes.length > 0) {
		lines.push("节点列表：");
		for (const node of value.nodes.slice(0, 40)) {
			const delay = typeof node.delay === "number" && Number.isFinite(node.delay) ? ` ${node.delay}ms` : "";
			lines.push(`  - ${node.name} [${shown(node.type)}]${delay}${node.needs_native ? "（需原生连接器）" : ""}`);
		}
		if (value.nodes.length > 40) lines.push(`  …… 另有 ${value.nodes.length - 40} 个`);
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
		`${shown(value.host)} → ${routeLabel(value.route)}`,
		`依据：${shown(value.reason)}`,
		`解析结果：${ips.length === 0 ? "（无）" : ips.join(", ")}`,
		`归属地：${geo === null ? "未知" : `${shown(geo.country, "?")}（${shown(geo.country_code, "?")}），来源 ${shown(geo.provider, "?")}`}${value.geo_source === null || value.geo_source === undefined ? "" : ` [${value.geo_source}]`}`,
		`连通性：${ping === null ? "未探测" : `icmp=${ping.icmp?.ok === true ? `${ping.icmp.time_ms}ms` : "失败"}，tcp=${ping.tcp_443?.ok === true ? `${ping.tcp_443.time_ms}ms` : "失败"}`}`
	];
	if (value.advice !== null && value.advice !== undefined) lines.push(`建议：${value.advice}`);
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
				`拒绝写到工作区之外：${destination}。请在「设置 → 下载代理」里把 allowOutsideWorkspace 打开，` +
					`或改存到 ${configuredDir}，或传一个位于 ${workspaceRoot(ctx, exec)} 之内的 save_path。`
			);
		}
		return destination;
	}

	// ---- dsh_download ------------------------------------------------------
	disposers.push(
		ctx.tools.register({
			name: "dsh_download",
			description:
				"从互联网下载文件到本地磁盘。插件自己决定走哪条路：境内目标直连，境外目标走配置好的代理" +
				"（自包含的订阅内核，或显式指定的 proxyUrl），直连失败会自动改用代理重试。" +
				"返回保存路径、字节数、sha256、速度和实际使用的路由。下载互联网文件请优先用它，不要用 curl / Invoke-WebRequest。",
			parameters: {
				type: "object",
				properties: {
					url: { type: "string", description: "完整的 http:// 或 https:// 下载地址。" },
					save_path: { type: "string", description: "目标文件路径，或一个目录（目录时按 URL 自动取文件名）。默认写到配置的下载目录。" },
					overwrite: { type: "boolean", description: "覆盖已存在的目标文件。默认 false。" },
					force_route: { type: "string", enum: ["auto", "proxy", "direct"], description: "auto（默认）按规则引擎分流；direct / proxy 强制走其中一条。" },
					max_mb: { type: "number", description: "本次调用覆盖配置的单文件大小上限（MB）。" },
					timeout_seconds: { type: "number", description: "本次调用覆盖配置的总时长预算（秒）。" }
				},
				required: ["url"],
				additionalProperties: false
			},
			output: { schema: OBJECT_OUTPUT_SCHEMA, render: (_args, value) => renderDownload(value) },
			isConcurrencySafe: () => true,
			presentCall: (args) => ({ card: "generic", kind: "fetch", title: "下载文件", rawInput: String(args?.url ?? "") }),
			presentResult: (args, result) => ({ card: "generic", title: result?.isError === true ? "下载失败" : "下载完成" }),
			execute: async (args, exec) => {
				const section = resolveConfig();
				const url = String(args?.url ?? "").trim();
				if (url.length === 0) throw new Error("缺少 url 参数");
				const forceRoute = ["auto", "proxy", "direct"].includes(String(args?.force_route ?? "auto")) ? String(args?.force_route ?? "auto") : "auto";

				try {
					const view = await upstream.resolve();
					const warnings = [];
					if (view.mode === "none") warnings.push("没有配置代理，任何目标都无法走代理");
					else if (view.available !== true) warnings.push(`代理内核不可用（${view.reason}）`);

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
						`${message}\n  上游模式：${modeLabel(view.mode)} —— ${view.reason}\n  建议：${hint ?? "检查 URL、目标路径，以及「设置 → 下载代理」"}`
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
				"汇报下载代理的当前状态：上游模式、订阅是否已加载、节点数量与延迟、当前选中的节点、本地规则内核端口、AI 平台保护状态、" +
				"会话保护状态，以及最近一次错误。用来排查「下载为什么走了 / 没走代理」。",
			parameters: {
				type: "object",
				properties: {
					refresh: { type: "boolean", description: "强制完整重新解析（重抓订阅、重建规则内核）。" },
					test_all: { type: "boolean", description: "同时对全部节点测速（较慢）。" },
					include_nodes: { type: "boolean", description: "是否在结果里带上节点列表。默认 true。" }
				},
				additionalProperties: false
			},
			output: { schema: OBJECT_OUTPUT_SCHEMA, render: (_args, value) => renderStatus(value) },
			isConcurrencySafe: () => true,
			presentCall: () => ({ card: "generic", kind: "other", title: "检查下载代理" }),
			presentResult: () => ({ card: "generic", title: "下载代理状态" }),
			execute: async (args) => {
				const view = await upstream.resolve({ refresh: args?.refresh === true });
				if (args?.test_all === true && view.available) await upstream.testAllLatencies();
				const status = upstream.status();
				const notes = [];
				if (status.nativeNodes > 0 && status.nativeConnector !== true) {
					notes.push(`提示：有 ${status.nativeNodes} 个节点需要可选的 Go 原生连接器，当前构建未打包，这些节点会被跳过。`);
				}
				if (status.mode === "none") {
					notes.push("提示：请在「设置 → 下载代理」里填订阅地址或 proxyUrl，才能让境外下载走代理。");
				}
				if (status.error !== null && status.error !== undefined) notes.push(`提示：${status.error}`);
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
					ai_protected: status.protectAiPlatforms,
					ai_direct_domain_count: status.protectedDomains.length,
					ai_direct_domains: status.protectedDomains,
					session_guard: upstream.guardState(),
					scope: status.scope,
					profile_count: status.profileCount,
					current_profile: status.currentProfile,
					profiles: status.profiles.map((profile) => ({
						id: profile.id,
						label: profile.label,
						source: profile.source,
						current: profile.current,
						auto_update: profile.autoUpdate,
						auto_update_hours: profile.autoUpdateHours,
						last_update_at: profile.lastUpdateAt,
						subscription_info: profile.subscriptionInfo
					})),
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
				"判断一个 URL 或主机名是境内还是境外，以及下载器会走哪条路。判定优先使用内置的离线规则库（完全不发网络请求）；" +
				"只有规则库判不出来时才做 DNS、在线 GeoIP 与 ping 探测。",
			parameters: {
				type: "object",
				properties: {
					url_or_host: { type: "string", description: "一个 URL，或裸主机名 / IP 字面量。" },
					ping: { type: "boolean", description: "是否同时做 ICMP + TCP 探测。默认 true。" }
				},
				required: ["url_or_host"],
				additionalProperties: false
			},
			output: { schema: OBJECT_OUTPUT_SCHEMA, render: (_args, value) => renderGeo(value) },
			isConcurrencySafe: () => true,
			presentCall: (args) => ({ card: "generic", kind: "search", title: "检查主机走哪条路由", rawInput: String(args?.url_or_host ?? "") }),
			presentResult: () => ({ card: "generic", title: "路由判定结果" }),
			execute: async (args, exec) => {
				const input = String(args?.url_or_host ?? "").trim();
				if (input.length === 0) throw new Error("缺少 url_or_host 参数");
				return await geoCheck(input, { ping: args?.ping !== false, upstream, exec });
			}
		})
	);

	// ---- dsh_session_guard -------------------------------------------------
	disposers.push(
		ctx.tools.register({
			name: "dsh_session_guard",
			description:
				"代理失能时保住模型连接。check 只读上报 $DSH_HOME/.env 里 NO_PROXY 对国内 AI 平台域名的覆盖情况；" +
				"apply 把缺失的域名合并进去（写前先备份，且绝不改动 HTTP_PROXY / HTTPS_PROXY）；restore 用最新备份还原。" +
				"这些域名进了 NO_PROXY 之后，关掉代理程序或节点掉线都不会再打断会话的长连接。",
			parameters: {
				type: "object",
				properties: {
					action: { type: "string", enum: ["check", "apply", "restore"], description: "check（默认）只读；apply 备份后写入；restore 还原到最新备份。" },
					extra_domains: { type: "array", items: { type: "string" }, description: "本次额外强制直连的域名（可填裸域名或完整 URL）。" }
				},
				additionalProperties: false
			},
			output: { schema: OBJECT_OUTPUT_SCHEMA, render: (_args, value) => renderGuard(value) },
			isConcurrencySafe: () => true,
			presentCall: (args) => ({ card: "generic", kind: "other", title: `会话保护：${args?.action ?? "check"}` }),
			presentResult: () => ({ card: "generic", title: "会话保护结果" }),
			execute: async (args) => {
				const section = resolveConfig();
				const requested = ["check", "apply", "restore"].includes(String(args?.action ?? "check")) ? String(args?.action ?? "check") : "check";
				const extra = (Array.isArray(args?.extra_domains) ? args.extra_domains : []).map(normalizeDomain).filter((domain) => domain.length > 0);
				const domains = composeDirectDomains({
					protectAiPlatforms: section.protectAiPlatforms !== false,
					extraDirectDomains: [...(section.extraDirectDomains ?? []), ...extra]
				});
				const envPath = envFilePath(process.env.DSH_HOME);
				const notes = [];

				let receipt = null;
				if (requested === "apply") receipt = applyGuard({ envPath, domains });
				else if (requested === "restore") receipt = restoreGuard({ envPath });

				const state = inspectGuard({ envPath, domains });
				if (requested === "apply" && receipt?.changed === true) {
					notes.push("提示：DSH 只在启动时读一次 $DSH_HOME/.env，所以要重启 DSH 这份全局代理策略才会生效。");
				}
				if (state.proxy_vars.length === 0) {
					notes.push("提示：该文件没有配置 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY，在配上其中一个之前这条 NO_PROXY 暂时不起作用。");
				}
				if (!state.covered) {
					notes.push(`提示：还缺 ${state.missing.slice(0, 8).join("、")}${state.missing.length > 8 ? ` 等 ${state.missing.length} 个域名` : ""}。用 action="apply" 合并进去。`);
				}

				return {
					action: requested,
					env_path: envPath,
					exists: state.exists,
					proxy_vars: state.proxy_vars,
					no_proxy: state.no_proxy_set ? state.suggested_line.slice("NO_PROXY=".length) : "",
					no_proxy_line: state.suggested_line,
					covered: state.covered,
					missing_count: state.missing.length,
					protected_domain_count: domains.length,
					protected_domains: domains,
					changed: receipt === null ? null : receipt.changed,
					added_count: receipt === null ? 0 : receipt.added.length,
					backup_path: receipt === null ? null : receipt.backupPath,
					restored: requested === "restore",
					notes
				};
			}
		})
	);

	// ---- dsh_profile -------------------------------------------------------
	disposers.push(
		ctx.tools.register({
			name: "dsh_profile",
			description:
				"管理节点配置，行为对齐 FlClash：一份配置就是一条订阅地址或一个导入的配置文件，带自己的名字、上次更新时间与自动更新间隔。" +
				"支持列出现有配置、从订阅地址或 clash:// 深链导入、从配置正文导入、更新、选择、删除、开关自动更新、排序与改名。" +
				"导入后下载工具会立刻使用选中的那份配置。",
			parameters: {
				type: "object",
				properties: {
					action: {
						type: "string",
						enum: ["list", "add_url", "add_file", "update", "select", "remove", "auto", "reorder", "rename"],
						description: "list（默认）列出；add_url / add_file 导入；update 重新下载；select 选用；remove 删除；auto 开关自动更新；reorder 排序；rename 改名。"
					},
					value: { type: "string", description: "add_url 用：订阅地址，或 clash://install-config?url=… 深链。" },
					label: { type: "string", description: "可选的名字；留空则用响应头里的文件名，再退回域名。" },
					content: { type: "string", description: "add_file 用：配置文件正文（YAML 或 base64 包裹的 YAML）。" },
					name: { type: "string", description: "add_file 用：文件名，用于推导名字。" },
					id: { type: "string", description: "update / select / remove / auto / rename 用：目标配置 id。" },
					enabled: { type: "boolean", description: "auto 用：是否开启自动更新。" },
					hours: { type: "number", description: "auto 用：自动更新间隔（小时）。" },
					ids: { type: "array", items: { type: "string" }, description: "reorder 用：按期望顺序排列的配置 id。" }
				},
				additionalProperties: false
			},
			output: { schema: OBJECT_OUTPUT_SCHEMA, render: (_args, value) => renderProfiles(value) },
			isConcurrencySafe: () => false,
			presentCall: (args) => ({ card: "generic", kind: "other", title: `节点配置：${args?.action ?? "list"}` }),
			presentResult: () => ({ card: "generic", title: "节点配置" }),
			execute: async (args) => {
				const requested = String(args?.action ?? "list");
				const notes = [];
				const snapshot = async () => {
					const view = await upstream.resolve();
					const status = upstream.status();
					return {
						action: requested,
						ok: true,
						current_id: status.currentProfile?.id ?? null,
						current_label: status.currentProfile?.label ?? null,
						node_count: view.available ? status.nodeCount : 0,
						profiles: status.profiles.map((profile) => ({
							...profile,
							node_count: profile.current ? status.nodeCount : null,
							subscription_info: profile.subscriptionInfo
						})),
						notes
					};
				};

				switch (requested) {
					case "list":
						return await snapshot();
					case "add_url": {
						if (typeof args?.value !== "string" || args.value.trim().length === 0) throw new Error("缺少 value（订阅地址或 clash:// 深链）");
						const profile = await upstream.addProfileFromUrl(args.value, {
							label: typeof args?.label === "string" ? args.label : undefined,
							autoUpdateHours: Number(args?.hours) > 0 ? Number(args.hours) : undefined
						});
						notes.push(`已导入「${profile.label}」。`);
						return await snapshot();
					}
					case "add_file": {
						if (typeof args?.content !== "string" || args.content.trim().length === 0) throw new Error("缺少 content（配置文件正文）");
						const profile = await upstream.addProfileFromFile(typeof args?.name === "string" && args.name.length > 0 ? args.name : "本地配置.yaml", args.content);
						notes.push(`已导入「${profile.label}」（本地文件配置，不会自动更新）。`);
						return await snapshot();
					}
					case "update": {
						if (typeof args?.id !== "string") throw new Error("缺少 id");
						const profile = await upstream.updateProfile(args.id);
						notes.push(`已更新「${profile.label}」。`);
						return await snapshot();
					}
					case "select": {
						if (typeof args?.id !== "string") throw new Error("缺少 id");
						const profile = await upstream.selectProfile(args.id);
						notes.push(`已切换到「${profile.label}」。`);
						return await snapshot();
					}
					case "remove": {
						if (typeof args?.id !== "string") throw new Error("缺少 id");
						const current = await upstream.removeProfile(args.id);
						notes.push(current === null ? "已删除，当前没有剩余配置。" : `已删除，当前使用「${current.label}」。`);
						return await snapshot();
					}
					case "auto": {
						if (typeof args?.id !== "string") throw new Error("缺少 id");
						const profile = await upstream.setProfileAutoUpdate(args.id, args?.enabled !== false, Number(args?.hours) > 0 ? Number(args.hours) : undefined);
						notes.push(`「${profile.label}」自动更新已${profile.autoUpdate ? `开启（每 ${profile.autoUpdateHours} 小时）` : "关闭"}。`);
						return await snapshot();
					}
					case "reorder": {
						if (!Array.isArray(args?.ids)) throw new Error("缺少 ids 数组");
						await upstream.reorderProfiles(args.ids);
						notes.push("顺序已保存。");
						return await snapshot();
					}
					case "rename": {
						if (typeof args?.id !== "string") throw new Error("缺少 id");
						const profile = await upstream.renameProfile(args.id, String(args?.label ?? ""));
						notes.push(`已改名为「${profile.label}」。`);
						return await snapshot();
					}
					default:
						throw new Error(`未知动作：${requested}`);
				}
			}
		})
	);

	// ---- dsh_run_proxied ---------------------------------------------------
	let delegatedSeq = 0;
	disposers.push(
		ctx.tools.register({
			name: "dsh_run_proxied",
			description:
				"让 git / curl 这类 shell 下载走本插件的代理：把命令包装成「这一次调用带代理环境」再交给 shell 工具执行（沙箱与权限策略照常生效）。" +
				"国内目标仍由插件的规则内核判定直连，国内 AI 平台域名直接绕过代理。execute=false 时只返回拼好的命令，交给你自己用 pwsh 跑。",
			parameters: {
				type: "object",
				properties: {
					command: { type: "string", description: "要执行的完整命令，例如 git clone https://github.com/x/y.git。" },
					execute: { type: "boolean", description: "是否直接执行。默认 true；false 只返回拼好的命令。" },
					shell: { type: "string", enum: ["pwsh", "bash"], description: "目标 shell，默认 pwsh（Windows）。" },
					workdir: { type: "string", description: "可选工作目录，仅 execute=true 时传给 shell 工具。" }
				},
				required: ["command"],
				additionalProperties: false
			},
			output: { schema: OBJECT_OUTPUT_SCHEMA, render: (_args, value) => renderProxiedRun(value) },
			isConcurrencySafe: () => false,
			presentCall: (args) => ({ card: "terminal", title: "带代理执行命令", description: String(args?.command ?? "").slice(0, 200) }),
			presentResult: (args, result) => ({ card: "terminal", title: result?.isError === true ? "执行失败" : "执行完成" }),
			execute: async (args, exec) => {
				const command = String(args?.command ?? "").trim();
				if (command.length === 0) throw new Error("缺少 command 参数");
				const requestedShell = args?.shell === "bash" ? "bash" : "pwsh";
				const env = upstream.shellProxyEnv();
				if (env === null) {
					throw new Error("代理内核还没就绪：请先在「设置 → 下载代理」里导入一份可用配置（或填 proxyUrl），然后再试。");
				}
				const prefix = buildShellPrefix({ shell: requestedShell, proxyUrl: env.proxyUrl, noProxy: env.noProxy });
				const composed = `${prefix}${command}`;

				if (args?.execute === false) {
					return {
						executed: false,
						shell: requestedShell,
						command: composed,
						no_proxy: env.noProxy,
						output: null,
						exit_note: "把 command 的内容原样交给 shell 工具执行即可。"
					};
				}

				const shellTool = ctx.tools.get(requestedShell) !== undefined ? requestedShell : ctx.tools.get("bash") !== undefined ? "bash" : "pwsh";
				const delegated = await ctx.tools.execute({
					callId: `${exec.callId}:proxied-${(delegatedSeq += 1)}`,
					rootCallId: exec.rootCallId,
					name: shellTool,
					arguments: {
						command: composed,
						...(typeof args?.workdir === "string" && args.workdir.length > 0 ? { workdir: args.workdir } : {})
					},
					agent: exec.agent,
					parent: exec.token,
					signal: exec.signal
				});
				const output = (delegated.content ?? [])
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				if (delegated.isError === true) {
					throw new Error(
						`命令执行失败：\n${output || delegated.error?.message || "未知错误"}\n` +
							"（也可以先用 execute=false 只拿拼好的命令，自己再调用 shell 工具）"
					);
				}
				return { executed: true, shell: shellTool, command: composed, no_proxy: env.noProxy, output, exit_note: null };
			}
		})
	);

	// ---- 工具守卫：拦住没走代理的境外 shell 下载 ----------------------------
	// 只拦「明确带 http(s) URL 的下载类命令」，且只在内核确实可用时才拦 ——
	// 拦下来却没有可用出口比不拦更糟。命令里已经带代理的一律放行。
	try {
		disposers.push(
			ctx.tools.guard((execution) => {
				if (resolveConfig().guardShellDownloads === false) return undefined;
				const toolName = String(execution?.name ?? "");
				if (toolName !== "pwsh" && toolName !== "bash") return undefined;
				const view = upstream.view();
				if (view.engine === null || view.engine === undefined || view.available !== true) return undefined;
				const command = String(execution?.arguments?.command ?? execution?.arguments?.script ?? "");
				if (command.trim().length === 0) return undefined;
				const verdict = classifyShellCommand(command, view.engine);
				if (verdict.foreign.length === 0) return undefined;
				return explainShellRouting({ foreign: verdict.foreign });
			})
		);
	} catch (error) {
		log.warn("could not register the shell-download guard: %s", String(error));
	}

	// ---- runtime skill -----------------------------------------------------
	ctx.inject?.(['skills'], (skillsCtx) => {
		try {
			disposers.push(
				skillsCtx.skills.register({
					name: "smart-download",
					source: ENTRY_ID,
					whenToUse:
						"当任务需要从互联网获取文件时 —— 安装包、GitHub Release 资产、模型权重、数据集、压缩包、磁盘镜像，或任何大文件；" +
						"以及当有人问某个网站是否需要代理时。",
					description:
						"用 dsh_download 下载互联网文件：境内目标直连，境外目标走插件自带的代理内核（自包含订阅或显式 proxyUrl），" +
						"直连失败会自动改用代理重试，返回值里带 sha256 与保存路径。下载互联网文件请优先用它，而不是 curl / Invoke-WebRequest。",
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

/** Render a session-guard report. */
function renderGuard(value) {
	if (value === null || typeof value !== "object") return text(value);
	const lines = [
		`动作：${actionLabel(value.action)}`,
		`配置文件：${shown(value.env_path)}${value.exists === false ? "（尚未创建）" : ""}`,
		`该文件里的全局代理变量：${Array.isArray(value.proxy_vars) && value.proxy_vars.length > 0 ? value.proxy_vars.join("、") : "无"}`,
		`NO_PROXY：${value.no_proxy && value.no_proxy.length > 0 ? value.no_proxy : "（未设置）"}`,
		`AI 平台强制直连：${value.protected_domain_count} 个域名 —— ${value.covered === true ? "已全部写入 NO_PROXY" : `还缺 ${value.missing_count} 个`}`
	];
	if (value.changed === true) {
		lines.push(`已写入合并后的 NO_PROXY，新增 ${value.added_count} 条`);
		if (value.backup_path) lines.push(`备份：${value.backup_path}`);
	} else if (value.changed === false) {
		lines.push("无需改动");
	}
	if (value.restored === true) lines.push(`已从备份 ${shown(value.backup_path)} 还原`);
	if (value.no_proxy_line && value.changed !== false) lines.push(`目标行：${value.no_proxy_line}`);
	if (Array.isArray(value.notes)) lines.push(...value.notes);
	return text(lines.join("\n"));
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
		reason = view.reason ?? "没有配置代理，下载会直连";
	} else {
		const decision = view.engine.decide(host);
		route = decision === "reject" ? "reject" : decision;
		reason =
			decision === "direct"
				? `内置规则库把 ${host} 判为境内/直连`
				: decision === "reject"
					? `当前规则拒绝访问 ${host}`
					: `内置规则库把 ${host} 判为境外/走代理`;
	}

	const ips = literal ? [host] : await resolveHost(host);
	const provisional = ips.filter((ip) => !isPrivateIp(ip));
	const allPrivate = ips.length > 0 && provisional.length === 0;

	// Only reach for the network when the offline tables could not decide.
	let geo = null;
	let geoSource = null;
	if (allPrivate && ips.length > 0) {
		geoSource = "内网地址";
	} else {
		const target = provisional[0] ?? ips[0] ?? null;
		if (target !== null && !literal) {
			geo = await geoLookupIP(target, { timeoutMs: 6000, signal: exec?.signal });
			if (geo !== null) geoSource = `在线 GeoIP（${geo.provider}）`;
		}
	}

	let pingResult = null;
	if (ping && ips.length > 0) {
		const [icmp, tcp] = await Promise.all([icmpPing(host), tcpPing(host, 443)]);
		pingResult = { icmp: { ok: icmp.ok, time_ms: icmp.timeMs }, tcp_443: { ok: tcp.ok, time_ms: tcp.timeMs } };
	}

	let advice;
	if (route === "proxy") {
		advice = view.available ? "该主机的下载会走代理内核。" : "该主机需要走代理，但没有可用节点 —— 请检查「设置 → 下载代理」。";
	} else if (route === "direct") {
		advice = "该主机的下载会直连，不经过任何代理。";
	} else {
		advice = "当前规则拒绝该主机，下载会按设计失败。";
	}
	if (allPrivate && !literal) {
		advice += ` 该域名解析到 ${ips.join("、")}，看起来是 hosts 改写或 DNS 污染。`;
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
const SKILL_CONTENT = `# 智能下载

本插件注册了四个工具。下载互联网文件请用它们，**不要**去 shell 里跑 \`curl\` / \`Invoke-WebRequest\` ——
那样完全绕开了插件的分流规则。

| 工具 | 用途 |
| --- | --- |
| \`dsh_download\` | 下载任何互联网文件。路由分流、大小上限、sha256、失败回退都已内置。 |
| \`dsh_proxy_status\` | 排查「为什么走了 / 没走代理」。 |
| \`dsh_geo_check\` | 回答「这个站是国内还是国外、会不会走代理」。 |
| \`dsh_session_guard\` | 检查或修复 \`$DSH_HOME/.env\` 里的 \`NO_PROXY\`，让会话自身的模型连接不依赖代理。 |
| \`dsh_profile\` | 管理节点配置（FlClash 式）：列出 / 从订阅地址或 \`clash://\` 深链导入 / 从配置正文导入 / 更新 / 选择 / 删除 / 开关自动更新 / 排序 / 改名。 |
| \`dsh_run_proxied\` | 让 \`git\` / \`curl\` 这类 shell 下载走本插件的代理（只作用于这一次调用）。 |

## git / curl 下载境外内容

**要跑 \`git clone\` / \`git pull\` / \`curl\` / \`wget\` 去境外取东西时，用 \`dsh_run_proxied\`**，不要直接调 shell 工具：

\`\`\`
dsh_run_proxied({ command: "git clone https://github.com/x/y.git" })
\`\`\`

它会为这一次 shell 调用注入代理环境，国内目标仍由插件内核判定直连，国内 AI 平台域名直接绕过。
如果只是下一个文件，**优先用 \`dsh_download\`**，它带 sha256、大小上限与失败回退。

插件还注册了一条工具守卫：当 shell 命令看起来要从境外下载、又没有带代理时，会被拦下来并提示你改用
\`dsh_run_proxied\`。命令里已经带了代理、或者内核没有可用出口时不会被拦。

## 工作约定

1. **要下载文件就直接调 \`dsh_download\`。** 不要先跑 \`dsh_geo_check\` —— 下载工具内部已经做了路由判定；
   \`dsh_geo_check\` 是用来回答问题的，不是前置步骤。
2. **不要用 \`curl\` / \`Invoke-WebRequest\` 代替**，除非用户明确要求 shell 命令。它们会完全绕开代理规则。
3. **路由是自动的，而且会如实上报。** 读返回值里的 \`route\` 与 \`route_reason\`：
   - \`direct\` —— 境内目标，不经过代理。
   - \`proxy\` —— 境外目标，经插件的节点下载。
   - \`fallback_used: true\` —— 直连失败，改用代理重试成功。
4. **如实汇报事实**：\`saved_to\`、\`bytes\`（转成人类可读）、\`sha256\`、\`speed_bps\`；用户关心时提一句路由。
5. **撞到大小上限先确认再改。** \`max_mb\` 默认 512。工具报「超过上限」时，把服务端声明的大小告诉用户、
   确认之后再提高 \`max_mb\`。
6. **没有可用代理出口时，绝不要偷偷退回 \`curl\`。** 告诉用户去 **设置 → 下载代理** 填订阅地址或 proxyUrl，然后重试。
7. **取消 / 停滞的下载不留半截文件**：临时文件总会被删掉，重跑永远安全。
8. **大文件不受宿主超时约束**，但仍受 \`download_timeout_s\`（默认 600 秒）约束。预计会久得多的，
   先跟用户确认，再在调用里传更大的 \`timeout_seconds\`。
9. **节点抖动绝不能打断会话。** 国内 AI 平台域名（DeepSeek、智谱/Z.ai、Kimi、通义、豆包/方舟、文心、混元、
   星火、MiniMax、零一万物、阶跃、商汤、百川、硅基流动、天工、盘古……）被钉在最高优先级的 DIRECT 规则上，
   对它们的下载不会被路由到节点，**即使 \`domesticDirect\` 关掉也一样**。
   如果用户反馈「代理一断会话就死」：先跑 \`dsh_session_guard\` 的 \`action="check"\`，说明清楚
   **Harness 自身的模型流量由 \`$DSH_HOME/.env\` 决定、不受本插件管辖**，再提议 \`action="apply"\`
   （它会先备份该文件，且绝不动 \`HTTP_PROXY\` / \`HTTPS_PROXY\`）。记得提醒：那个文件要**重启 DSH** 才生效。

## 覆盖范围的边界（用户问起时要说清楚）

本插件**只管它自己的下载**。\`web_fetch\`，以及 shell 工具里的 \`curl\` / \`git\` / \`npm\`，
由 DSH 启动期的代理策略（\`$DSH_HOME/.env\` 里的 \`HTTP_PROXY\` / \`HTTPS_PROXY\`）决定，不归本插件管。
用户需要那些也走代理时，让他去改那个文件。
`;

export { Config, CONFIG_KEYS, ENTRY_ID, SETTINGS_NAMESPACE, apply, inject, name };

/** Renderers and helpers exposed for the offline test suite only. */
export const __internals = { plain, renderDownload, renderGeo, renderGuard, renderProfiles, renderProxiedRun, renderStatus, shown, AI_DIRECT_DOMAINS };
