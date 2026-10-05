/**
 * Built-in DIRECT allow-list for Chinese AI platforms.
 *
 * Why this exists: a proxy node that flaps takes down every long-lived
 * connection that goes through it. The model APIs this harness talks to are all
 * domestic services that never needed a proxy in the first place, so the
 * downloader pins them to DIRECT at the highest rule priority — ahead of the
 * subscription's own rules and ahead of the user's `extraRules`.
 *
 * Two things consume this list:
 * - `UpstreamManager` turns it into `DOMAIN-SUFFIX,<domain>,DIRECT` lines so no
 *   download to an AI endpoint can ever be routed through a node;
 * - `session-guard.js` turns it into a `NO_PROXY` value for `$DSH_HOME/.env`, so
 *   the harness's *own* LLM traffic stays direct even when the launcher's global
 *   proxy policy is active.
 *
 * Entries are matched as suffixes (`deepseek.com` also covers
 * `api.deepseek.com`). A stale entry is harmless — it simply never matches.
 * @module dsh-downloader/ai-domains
 */

/** Domestic AI platform domains that must always be reached directly. */
export const AI_DIRECT_DOMAINS = [
	// DeepSeek — this harness's own model endpoint
	"deepseek.com",
	// 智谱 AI / Z.ai / ChatGLM
	"bigmodel.cn",
	"z.ai",
	"chatglm.cn",
	// 月之暗面 Kimi
	"moonshot.cn",
	"moonshot.ai",
	"kimi.com",
	// 阿里通义千问 / 百炼 DashScope
	"dashscope.aliyuncs.com",
	"tongyi.aliyun.com",
	// 字节跳动 豆包 / 火山方舟 Ark
	"volces.com",
	"volcengine.com",
	"doubao.com",
	// 百度文心一言 / 千帆
	"baidubce.com",
	"yiyan.baidu.com",
	// 腾讯混元
	"hunyuan.tencent.com",
	"tencentcloudapi.com",
	// 科大讯飞 星火
	"xfyun.cn",
	"xf-yun.com",
	// MiniMax
	"minimax.chat",
	"minimaxi.com",
	// 零一万物
	"lingyiwanwu.com",
	"01.ai",
	// 阶跃星辰
	"stepfun.com",
	"stepfun.ai",
	// 商汤 日日新
	"sensetime.com",
	"sensecore.io",
	// 百川智能
	"baichuan-ai.com",
	// 硅基流动 SiliconFlow
	"siliconflow.cn",
	"siliconflow.com",
	// 昆仑万维 天工
	"tiangong.cn",
	"skywork.ai",
	// 华为云 盘古 / ModelArts
	"huaweicloud.com",
	"myhuaweicloud.com",
	// 网易有道 子曰
	"youdao.com",
	// 澜舟科技
	"langboat.com",
	// 元象 XVERSE
	"xverse.cn",
	// 面壁智能
	"modelbest.cn",
	// 出门问问
	"mobvoi.com",
	// 国家超算互联网 / 智算平台
	"scnet.cn",
	"openi.cn"
];

/**
 * Normalize one user-supplied domain into a bare lowercase suffix.
 * Accepts `https://api.example.com/v1`, `*.example.com`, ` example.com `.
 * @returns the bare host, or "" when nothing usable remains.
 */
export function normalizeDomain(value) {
	if (typeof value !== "string") return "";
	let text = value.trim().toLowerCase();
	if (text.length === 0) return "";
	if (text.includes("://")) {
		try {
			text = new URL(text).hostname;
		} catch {
			text = text.slice(text.indexOf("://") + 3);
		}
	}
	text = text.split("/")[0].split(":")[0].replace(/^\*\./, "").replace(/^\.+/, "").replace(/\.+$/, "");
	return /^[a-z0-9.-]+$/.test(text) && text.includes(".") ? text : "";
}

/**
 * Compose the effective DIRECT domain list.
 * @param options - `protectAiPlatforms` toggle and user `extraDirectDomains`.
 * @returns a de-duplicated, sorted list of bare suffixes.
 */
export function composeDirectDomains({ protectAiPlatforms = true, extraDirectDomains = [] } = {}) {
	const domains = new Set();
	if (protectAiPlatforms !== false) for (const domain of AI_DIRECT_DOMAINS) domains.add(domain);
	for (const raw of Array.isArray(extraDirectDomains) ? extraDirectDomains : []) {
		const normalized = normalizeDomain(raw);
		if (normalized.length > 0) domains.add(normalized);
	}
	return [...domains].sort();
}

/**
 * Turn a domain list into rule-engine lines.
 * @param domains - bare suffixes.
 * @returns `DOMAIN-SUFFIX,<domain>,DIRECT` lines in list order.
 */
export function directRuleLines(domains) {
	return domains.map((domain) => `DOMAIN-SUFFIX,${domain},DIRECT`);
}
