/**
 * 把本插件的代理接进 shell 命令。
 *
 * 背景：`git` / `curl` 跑在 shell 子进程里，工具型插件无法在进程外截获它们。
 * 因此"适配"由两半组成：
 * 1. 一段 shell 前缀，把这一个命令的 `HTTP_PROXY` / `HTTPS_PROXY` 指向本插件的
 *    规则内核（内核再按规则决定直连还是走节点），**只影响这一次 shell 调用**；
 * 2. 一条工具守卫，在检测到"从境外下载"的 shell 命令时拦下来，告诉模型改用
 *    `dsh_run_proxied` 或 `dsh_download`。
 *
 * 本模块只做纯计算，便于离线测试。
 * @module dsh-downloader/shell-proxy
 */
import { isPrivateIp } from "../download/util.js";

/** 代理相关的环境变量名，大小写都写，兼容 curl / git / npm。 */
export const PROXY_ENV_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

/** 看起来像"要从网上取东西"的命令。 */
const DOWNLOAD_HINT = /\b(git\s+(?:clone|fetch|pull|submodule)|curl|wget|Invoke-WebRequest|iwr|Start-BitsTransfer)\b/i;

/** 命令里已经带代理的迹象（避免拦住模型按提示修正后的重试）。 */
const ALREADY_PROXIED = /(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy|\s-x\s+https?:\/\/|--proxy|http\.proxy|ProxyCommand)/i;

/** 提取命令里的 http(s) URL，去重。 */
export function extractHttpUrls(command) {
	const text = String(command ?? "");
	const found = text.match(/https?:\/\/[^\s"'`;|&)<>]+/gi) ?? [];
	const unique = [];
	for (const raw of found) {
		const cleaned = raw.replace(/[.,;:]+$/, "");
		if (!unique.includes(cleaned)) unique.push(cleaned);
	}
	return unique;
}

/** 主机是否是本机/内网（这类目标永远不该被判成"需要代理"）。 */
function isLocalHost(host) {
	const text = String(host ?? "").toLowerCase().replace(/^\[|\]$/g, "");
	if (text.length === 0) return false;
	if (text === "localhost" || text.endsWith(".localhost") || text.endsWith(".local")) return true;
	return isPrivateIp(text);
}

/**
 * 判断一条 shell 命令是否会从境外下载。
 *
 * 只认「明确带 http(s) URL 的下载类命令」：`git clone/fetch/pull/submodule`、
 * `curl`、`wget`、`Invoke-WebRequest`。SSH 形式（`git@github.com:…`）不走 HTTP，
 * 代理环境变量对它无效，因此不会被判定，也就不会被拦。
 *
 * @param command - 完整的 shell 命令。
 * @param engine - 规则引擎（`{ decide(host) }`），null 时不做判定。
 * @returns `{ isDownload, alreadyProxied, urls, foreign }`
 */
export function classifyShellCommand(command, engine) {
	const text = String(command ?? "");
	const isDownload = DOWNLOAD_HINT.test(text);
	const alreadyProxied = ALREADY_PROXIED.test(text);
	const urls = extractHttpUrls(text);
	const foreign = [];
	if (isDownload && engine !== null && engine !== undefined && !alreadyProxied) {
		for (const url of urls) {
			let host = "";
			try {
				host = new URL(url).hostname;
			} catch {
				continue;
			}
			if (isLocalHost(host)) continue;
			if (engine.decide(host) === "proxy") foreign.push({ url, host });
		}
	}
	return { isDownload, alreadyProxied, urls, foreign };
}

/** 代理 URL：用户名固定 `dsh`，密码是本进程的令牌（本插件的内核按它鉴权）。 */
export function buildProxyUrl({ host = "127.0.0.1", port, token }) {
	return `http://dsh:${encodeURIComponent(String(token))}@${host}:${port}`;
}

/** 单个环境变量赋值语句。 */
function assignment(shell, name, value) {
	if (String(shell).toLowerCase() === "bash") return `export ${name}='${value}';`;
	return `$env:${name}='${value}';`;
}

/**
 * 组装一段 shell 前缀，把这一个命令的代理指向本插件内核。
 *
 * 除了 `*_PROXY`，还会通过 `GIT_CONFIG_COUNT` 给 git 单独喂两条配置：
 * - `http.proxy` —— **git 不会像 curl 那样预发 `Proxy-Authorization`**，把带凭据的
 *   代理写进 `http.proxy` 才让它把凭据交给 libcurl；
 * - `http.proxyAuthMethod=basic` —— 与内核的 407 挑战（Basic）对上。
 *
 * 这两条对非 git 命令完全无副作用（git 之外没人读它们），所以不做命令嗅探。
 *
 * @param shell - `pwsh`（默认）或 `bash`。
 * @param proxyUrl - {@link buildProxyUrl} 的结果。
 * @param noProxy - 绕过列表（回环 + 国内 AI 平台域名）。
 * @returns 可直接拼在原命令前面的字符串。
 */
export function buildShellPrefix({ shell = "pwsh", proxyUrl, noProxy }) {
	const parts = PROXY_ENV_NAMES.map((name) => assignment(shell, name, proxyUrl));
	parts.push(assignment(shell, "NO_PROXY", noProxy), assignment(shell, "no_proxy", noProxy));
	const gitConfig = [
		["http.proxy", proxyUrl],
		["http.proxyAuthMethod", "basic"]
	];
	parts.push(assignment(shell, "GIT_CONFIG_COUNT", String(gitConfig.length)));
	gitConfig.forEach(([key, value], index) => {
		parts.push(assignment(shell, `GIT_CONFIG_KEY_${index}`, key));
		parts.push(assignment(shell, `GIT_CONFIG_VALUE_${index}`, value));
	});
	return `${parts.join(" ")} `;
}

/** 提示模型该怎么做的中文说明。 */
export function explainShellRouting({ foreign }) {
	const hosts = [...new Set(foreign.map((item) => item.host))];
	return (
		`这条命令会从境外下载（${hosts.join("、")}），但当前 shell 没有走本插件的代理。` +
		"请改用 dsh_run_proxied 跑这条命令（它会为这一次调用注入代理环境），" +
		"或者如果只是要下一个文件，直接用 dsh_download。"
	);
}

/**
 * 组装委派给 shell 工具的参数字典。
 *
 * shell 工具的 `description` 是**必填**的 —— 漏了它会以
 * 「missing required property "description"」直接失败（实测踩过）。
 * @param options - 包装后的命令、可选描述与工作目录。
 * @returns 可直接作为 `arguments` 传给 shell 工具的字典。
 */
export function buildShellToolArguments({ command, description, workdir }) {
	const text = typeof description === "string" && description.trim().length > 0
		? description.trim()
		: `带代理执行：${String(command ?? "").trim().slice(0, 60)}`;
	const payload = { command, description: text };
	if (typeof workdir === "string" && workdir.trim().length > 0) payload.workdir = workdir;
	return payload;
}
