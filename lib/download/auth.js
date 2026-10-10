/**
 * 凭据解析：把「引用」变成请求头。
 *
 * 存在的理由：需要鉴权的下载（GitHub Actions 产物、私有 Release、内部制品库）必须在请求里带
 * `Authorization`，但**让模型把 token 当工具参数传进来，token 就会永久留在会话记录里**。
 * 所以这里只接受「引用」，由插件自己去取：
 *
 * - `gh`          —— 跑 `gh auth token`，从 GitHub CLI 自己的凭据库取
 * - `env:NAME`    —— 读环境变量
 * - `bearer:xxx`  —— 直接给字面量（方便，但 token 会进会话记录，仅限非敏感场景）
 *
 * @module dsh-downloader/auth
 */
import { execFile } from "node:child_process";

/** 跨域跳转时必须丢弃的请求头：它们只该发给最初那台主机。 */
export const SENSITIVE_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/** 跑一条命令并取回 stdout。 */
function run(command, args, timeoutMs = 10000) {
	return new Promise((resolve, reject) => {
		execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
			if (error !== null && error !== undefined) {
				const detail = String(stderr ?? "").trim().slice(0, 200);
				reject(new Error(detail.length > 0 ? detail : error.message));
				return;
			}
			resolve(String(stdout ?? ""));
		});
	});
}

/**
 * 解析一个凭据引用。
 * @param auth - `gh` / `env:NAME` / `bearer:token`，空值表示不需要鉴权。
 * @returns `{ headers, source, warning }`；`source` 是给人看的中文说明。
 */
export async function resolveAuth(auth, options = {}) {
	const raw = typeof auth === "string" ? auth.trim() : "";
	if (raw.length === 0) return { headers: {}, source: null, warning: null };

	if (raw === "gh") {
		const hostname = typeof options.ghHostname === "string" && options.ghHostname.length > 0 ? options.ghHostname : "github.com";
		let token = "";
		try {
			token = (await run("gh", ["auth", "token", "--hostname", hostname])).trim();
		} catch (error) {
			throw new Error(
				`取 GitHub 凭据失败（auth="gh"）：${error instanceof Error ? error.message : String(error)}；` +
					"确认 `gh auth status` 已登录，或改用 auth=\"env:变量名\"。"
			);
		}
		if (token.length === 0) throw new Error(`gh 没有返回 ${hostname} 的 token；先跑 gh auth login`);
		return { headers: { Authorization: `Bearer ${token}` }, source: `gh CLI（${hostname}）`, warning: null };
	}

	if (raw.startsWith("env:")) {
		const name = raw.slice(4).trim();
		if (name.length === 0) throw new Error('auth="env:" 后面要写变量名，例如 auth="env:GH_TOKEN"');
		const value = process.env[name];
		if (typeof value !== "string" || value.trim().length === 0) throw new Error(`环境变量 ${name} 没有值`);
		return { headers: { Authorization: `Bearer ${value.trim()}` }, source: `环境变量 ${name}`, warning: null };
	}

	if (raw.startsWith("bearer:")) {
		const token = raw.slice(7).trim();
		if (token.length === 0) throw new Error('auth="bearer:" 后面要写 token');
		return {
			headers: { Authorization: `Bearer ${token}` },
			source: "字面 token",
			warning: "直接把 token 写在参数里会让它留在会话记录中；敏感场景请改用 auth=\"gh\" 或 auth=\"env:变量名\""
		};
	}

	throw new Error(`无法识别的 auth：${raw}（支持 gh / env:变量名 / bearer:token）`);
}

/** 这条请求头里有没有不该跟着重定向走的凭据。 */
export function hasSensitiveHeaders(headers) {
	if (headers === null || headers === undefined) return false;
	const keys = Object.keys(headers).map((key) => key.toLowerCase());
	return keys.some((key) => SENSITIVE_HEADERS.includes(key));
}

/** 复制一份并去掉凭据头。 */
export function stripSensitiveHeaders(headers) {
	const out = {};
	for (const [key, value] of Object.entries(headers ?? {})) {
		if (SENSITIVE_HEADERS.includes(key.toLowerCase())) continue;
		out[key] = value;
	}
	return out;
}

/**
 * 清理调用方给的请求头：丢掉会破坏请求的头，避免把下载搞坏。
 * @returns 可安全合并进请求的头。
 */
export function sanitizeHeaders(headers) {
	if (headers === null || headers === undefined || typeof headers !== "object") return {};
	const blocked = ["host", "content-length", "connection", "transfer-encoding", "proxy-authorization", "proxy-connection", "upgrade"];
	const out = {};
	for (const [key, value] of Object.entries(headers)) {
		if (typeof key !== "string" || key.trim().length === 0) continue;
		if (typeof value !== "string" && typeof value !== "number") continue;
		if (blocked.includes(key.trim().toLowerCase())) continue;
		out[key.trim()] = String(value);
	}
	return out;
}
