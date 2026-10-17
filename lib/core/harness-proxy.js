/**
 * [dsh-downloader] 把内核开放给 harness 自身的出网。
 *
 * 默认情况下内核只用「本进程随机令牌」保护，只服务本插件自己的下载。开启
 * `harnessProxy` 之后：
 *   1. 内核绑一个**固定端口**（`.env` 里要写死它，随机端口没法指）；
 *   2. 额外接受一个**持久化令牌**（重启不变，否则每次重启都 407）；
 *   3. 把 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 写进 `$DSH_HOME/.env`，
 *      DSH 启动时会据此装全局 dispatcher，并把变量传给子进程。
 *
 * 覆盖范围：`web_fetch`、shell 子进程（curl/git/npm）、MCP 的 HTTP 传输、
 * 以及 jobs/workflow/subagent 派生的进程。
 * **覆盖不到**：Electron 渲染进程/内嵌 webview —— Chromium 读的是**系统代理**，
 * 不读环境变量。
 *
 * 本模块只碰自己那 6 个 `*_PROXY` 变量与 `NO_PROXY`，其它行一律不动；写前备份。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { LOOPBACK_NO_PROXY, composeNoProxy, readNoProxy, splitEntries } from "./session-guard.js";

/** 内核固定端口的默认值。 */
export const DEFAULT_HARNESS_PORT = 17890;

/** 持久化令牌的文件名（放在插件数据目录里）。 */
export const HARNESS_TOKEN_FILE = "harness-token.txt";

/** 我们会写入/清除的 `.env` 键。大小写各一份，兼容只认其中一种的程序。 */
export const HARNESS_ENV_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy"
];

function tokenPath(dataDir) {
	return join(dataDir, HARNESS_TOKEN_FILE);
}

/**
 * 读取持久化令牌；不存在时生成一个。
 * @param dataDir - 插件数据目录。
 * @param create - false 时只读，不存在返回 null（用于 `status` 不改磁盘）。
 */
export function loadHarnessToken(dataDir, { create = true } = {}) {
	const file = tokenPath(dataDir);
	try {
		const raw = readFileSync(file, "utf8").trim();
		if (/^[0-9a-f]{32,}$/i.test(raw)) return raw;
	} catch {
		// 不存在或读不了 —— 下面按需生成。
	}
	if (!create) return null;
	const token = randomBytes(24).toString("hex");
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(file, `${token}\n`, { encoding: "utf8", mode: 0o600 });
	return token;
}

/** 令牌文件路径，供调用方展示。 */
export function harnessTokenFile(dataDir) {
	return tokenPath(dataDir);
}

/** 删掉持久化令牌（关闭开放时可选）。 */
export function deleteHarnessToken(dataDir) {
	try {
		unlinkSync(tokenPath(dataDir));
		return true;
	} catch {
		return false;
	}
}

/** 拼出写进 `.env` 的代理地址：`http://dsh:<令牌>@127.0.0.1:<端口>`。 */
export function buildHarnessProxyUrl({ port, token }) {
	if (!Number.isInteger(port) || port <= 0) throw new Error("端口无效");
	if (typeof token !== "string" || token.length === 0) throw new Error("令牌无效");
	return `http://dsh:${token}@127.0.0.1:${port}`;
}

/** 从 `.env` 正文里读出现有的 `HTTP_PROXY` 值（没有则 null）。 */
export function readHarnessProxyUrl(content) {
	for (const line of String(content).split(/\r?\n/)) {
		const match = /^\s*http_proxy\s*=\s*(.*)$/i.exec(line);
		if (match !== null) return match[1].trim() || null;
	}
	return null;
}

/** `.env` 里是否已经有我们写的那几个 `*_PROXY` 键。 */
export function hasHarnessProxyEnv(content) {
	const keys = new Set(HARNESS_ENV_KEYS.map((key) => key.toLowerCase()));
	for (const line of String(content).split(/\r?\n/)) {
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
		if (match !== null && keys.has(match[1].toLowerCase())) return true;
	}
	return false;
}

/** 把 6 个 `*_PROXY` 行摘掉（保留其它所有行）。 */
export function stripHarnessProxyEnv(content) {
	const keys = new Set(HARNESS_ENV_KEYS.map((key) => key.toLowerCase()));
	const kept = String(content)
		.split(/\r?\n/)
		.filter((line) => {
			const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
			if (match === null) return true;
			return !keys.has(match[1].toLowerCase());
		});
	return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** 写入或替换 6 个 `*_PROXY` 行。 */
export function upsertHarnessProxyEnv(content, url) {
	const keys = new Set(HARNESS_ENV_KEYS.map((key) => key.toLowerCase()));
	const seen = new Set();
	const lines = [];
	for (const line of String(content).split(/\r?\n/)) {
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
		if (match !== null && keys.has(match[1].toLowerCase())) {
			const key = HARNESS_ENV_KEYS.find((candidate) => candidate.toLowerCase() === match[1].toLowerCase());
			if (seen.has(key)) continue;
			seen.add(key);
			lines.push(`${key}=${url}`);
			continue;
		}
		lines.push(line);
	}
	for (const key of HARNESS_ENV_KEYS) {
		if (!seen.has(key)) lines.push(`${key}=${url}`);
	}
	return lines.join("\n");
}

function backup(envPath, stamp) {
	const suffix = stamp ?? new Date().toISOString().replace(/[:.]/g, "-");
	const backupPath = `${envPath}.bak-${suffix}`;
	copyFileSync(envPath, backupPath);
	return backupPath;
}

/**
 * 把内核地址写进 `$DSH_HOME/.env`。
 *
 * `NO_PROXY` 会被补上**回环 + 国内 AI 平台域名**：前者避免「代理指向自己」的死循环，
 * 后者保证代理抖动时模型长连接不走代理（否则会话会断）。
 */
export function writeHarnessProxyEnv({ envPath, url, directDomains = [], stamp }) {
	const exists = existsSync(envPath);
	const previous = exists ? readFileSync(envPath, "utf8") : "";
	let backupPath = null;
	if (exists) backupPath = backup(envPath, stamp);
	let next = upsertHarnessProxyEnv(previous, url);
	const noProxyDomains = [...LOOPBACK_NO_PROXY, ...directDomains];
	const noProxy = composeNoProxy(readNoProxy(next), noProxyDomains);
	const withoutNoProxy = next
		.split(/\r?\n/)
		.filter((line) => !/^\s*no_proxy\s*=/i.test(line));
	next = `${withoutNoProxy.join("\n").replace(/\n+$/, "")}\nNO_PROXY=${noProxy}\nno_proxy=${noProxy}\n`;
	writeFileSync(envPath, next, "utf8");
	return { changed: true, envPath, backupPath, url, noProxy, previous };
}

/** 从 `.env` 里撤掉我们写的东西（`NO_PROXY` 保留，它只影响不走代理的域名）。 */
export function clearHarnessProxyEnv({ envPath, stamp }) {
	if (!existsSync(envPath)) return { changed: false, envPath, backupPath: null };
	const previous = readFileSync(envPath, "utf8");
	if (!hasHarnessProxyEnv(previous)) return { changed: false, envPath, backupPath: null, previous };
	const backupPath = backup(envPath, stamp);
	writeFileSync(envPath, stripHarnessProxyEnv(previous), "utf8");
	return { changed: true, envPath, backupPath, previous };
}

/** 只读检查：`.env` 现在指向哪、和期望值是否一致。 */
export function inspectHarnessProxy({ envPath, expectedUrl }) {
	const exists = existsSync(envPath);
	const content = exists ? readFileSync(envPath, "utf8") : "";
	const current = readHarnessProxyUrl(content);
	return {
		envPath,
		exists,
		current,
		expected: expectedUrl ?? null,
		matches: expectedUrl === null ? current !== null : current === expectedUrl,
		hasProxyVars: hasHarnessProxyEnv(content),
		noProxy: readNoProxy(content)
	};
}
