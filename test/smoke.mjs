/**
 * Smoke tests: rule engine, subscription parsing, routing, the HTTP client,
 * and a real end-to-end download through the loopback rule core.
 *
 * No network access is required: everything runs against a throwaway local
 * HTTP server and the plugin's own `ProxyServer`.
 *
 *   node test/smoke.mjs
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { RuleEngine } from "../lib/core/rules.js";
import { ProxyServer } from "../lib/core/proxy-server.js";
import { parseSubscription } from "../lib/core/subscription.js";
import { decideRoute, NoUpstreamError } from "../lib/download/route.js";
import { attemptDownload, HttpStatusError } from "../lib/download/fetch-file.js";
import { httpFlow, parseProxyUrl } from "../lib/download/http.js";
import { filenameFromDisposition, filenameFromUrl, humanSize, isPrivateIp, pickFilename, sanitizeFilename } from "../lib/download/util.js";

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
	if (condition) {
		passed += 1;
		console.log(`  ok   ${label}`);
	} else {
		failed += 1;
		failures.push(label);
		console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
	}
}

function equal(label, actual, expected) {
	check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function expectThrow(label, fn, matcher) {
	try {
		await fn();
		check(label, false, "nothing was thrown");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		check(label, matcher === undefined || matcher.test(message), `threw: ${message}`);
	}
}

function section(title) {
	console.log(`\n== ${title} ==`);
}

// ---------------------------------------------------------------------------
// fixture server
// ---------------------------------------------------------------------------
const PAYLOAD = randomBytes(512 * 1024);
const PAYLOAD_SHA = createHash("sha256").update(PAYLOAD).digest("hex");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dshdl-smoke-"));

const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	switch (url.pathname) {
		case "/payload.bin":
			res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(PAYLOAD.length) });
			res.end(PAYLOAD);
			return;
		case "/named":
			res.writeHead(200, { "content-disposition": 'attachment; filename="report final.zip"' });
			res.end("ok");
			return;
		case "/redirect":
			res.writeHead(302, { location: "/payload.bin" });
			res.end();
			return;
		case "/redirect-loop":
			res.writeHead(302, { location: "/redirect-loop" });
			res.end();
			return;
		case "/missing":
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("nope");
			return;
		case "/too-big":
			res.writeHead(200, { "content-length": String(64 * 1024 * 1024) });
			res.end("x");
			return;
		case "/chunked": {
			// No content-length: exercises the streaming byte cap rather than the
			// declared-length early refusal.
			res.writeHead(200, { "content-type": "application/octet-stream" });
			let sent = 0;
			const push = () => {
				while (sent < PAYLOAD.length) {
					sent += 64 * 1024;
					if (!res.write(PAYLOAD.subarray(Math.max(0, sent - 64 * 1024), Math.min(sent, PAYLOAD.length)))) return;
				}
				res.end();
			};
			res.on("drain", push);
			push();
			return;
		}
		case "/slow":
			res.writeHead(200);
			res.write("start");
			return; // never ends: exercises the stall detector
		default:
			res.writeHead(404);
			res.end();
	}
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const core = new ProxyServer({ engine: { decide: () => "direct" }, resolveNode: () => null });
const corePort = await core.start(0);
const CORE = { socks: false, host: "127.0.0.1", port: corePort };

// ---------------------------------------------------------------------------
section("util");
equal("humanSize(0)", humanSize(0), "0 B");
equal("humanSize(1536)", humanSize(1536), "1.50 KB");
equal("humanSize(73400320)", humanSize(73400320), "70.0 MB");
check("isPrivateIp(127.0.0.1)", isPrivateIp("127.0.0.1") === true);
check("isPrivateIp(10.1.2.3)", isPrivateIp("10.1.2.3") === true);
check("isPrivateIp(8.8.8.8) is false", isPrivateIp("8.8.8.8") === false);
check("isPrivateIp(::1)", isPrivateIp("::1") === true);
check("isPrivateIp(fd00::1)", isPrivateIp("fd00::1") === true);
equal("filenameFromUrl", filenameFromUrl("https://example.com/a/b/app.zip?x=1"), "app.zip");
equal("filenameFromUrl percent-encoded", filenameFromUrl("https://example.com/%E4%B8%AD%E6%96%87.zip"), "中文.zip");
equal("filenameFromUrl root", filenameFromUrl("https://example.com/"), "");
equal("sanitizeFilename strips separators", sanitizeFilename("a/b\\c:d"), "a_b_c_d");
equal("filenameFromDisposition quoted", filenameFromDisposition('attachment; filename="report final.zip"'), "report final.zip");
equal("filenameFromDisposition rfc5987", filenameFromDisposition("attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.zip"), "报告.zip");
equal("pickFilename prefers the header", pickFilename("https://x/y.bin", { "content-disposition": 'attachment; filename="z.bin"' }), "z.bin");
equal("pickFilename falls back to the URL", pickFilename("https://x/y.bin", {}), "y.bin");

// ---------------------------------------------------------------------------
section("http.parseProxyUrl");
equal("bare host:port", JSON.stringify(parseProxyUrl("127.0.0.1:7890")), JSON.stringify({ socks: false, secure: false, host: "127.0.0.1", port: 7890, raw: "127.0.0.1:7890", auth: null }));
check("socks5 detected", parseProxyUrl("socks5://127.0.0.1:1080").socks === true);
equal("socks5 default port", parseProxyUrl("socks5://127.0.0.1").port, 1080);
check("http default port", parseProxyUrl("http://p.example").port === 80);
check("credentials parsed", parseProxyUrl("http://u:p@h:1").auth.username === "u");
equal("garbage rejected", parseProxyUrl("not a url"), null);
equal("empty rejected", parseProxyUrl(""), null);
equal("ftp rejected", parseProxyUrl("ftp://h:21"), null);

// ---------------------------------------------------------------------------
section("RuleEngine");
const engine = new RuleEngine({});
equal("github.com → proxy", engine.decide("github.com"), "proxy");
equal("objects.githubusercontent.com → proxy", engine.decide("objects.githubusercontent.com"), "proxy");
equal("www.baidu.com → direct", engine.decide("www.baidu.com"), "direct");
equal("a.deep.sub.baidu.com → direct", engine.decide("a.deep.sub.baidu.com"), "direct");
equal("example.cn → direct", engine.decide("example.cn"), "direct");
equal("unknown tld → proxy", engine.decide("totally-unknown-host.test"), "proxy");

const overridden = new RuleEngine({ extraRules: ["DOMAIN-SUFFIX,github.com,DIRECT"] });
equal("extraRules win over the default", overridden.decide("github.com"), "direct");

const excluded = new RuleEngine({
	subscriptionRules: ["DOMAIN-SUFFIX,blocked.example,REJECT"],
	excludeRules: ["blocked.example"]
});
equal("excludeRules drop a subscription rule", excluded.decide("blocked.example"), "proxy");

const rejecting = new RuleEngine({ extraRules: ["DOMAIN-SUFFIX,ads.example,REJECT"] });
equal("REJECT is honoured", rejecting.decide("cdn.ads.example"), "reject");

const allProxy = new RuleEngine({ extraRules: ["MATCH,PROXY"] });
equal("MATCH,PROXY catches everything", allProxy.decide("www.baidu.com"), "proxy");

// ---------------------------------------------------------------------------
section("subscription parsing");
const yamlBody = [
	"proxies:",
	"  - {name: n1, type: ss, server: 1.2.3.4, port: 8388, cipher: aes-128-gcm, password: p}",
	"  - {name: n2, type: trojan, server: 5.6.7.8, port: 443, password: q}",
	"  - {name: DIRECT, type: direct}",
	"proxy-groups:",
	"  - {name: AUTO, type: url-test, proxies: [n1, n2, ghost]}",
	"rules:",
	"  - DOMAIN-SUFFIX,corp.example,DIRECT",
	"  - MATCH,PROXY"
].join("\n");
const parsedYaml = parseSubscription(yamlBody);
equal("yaml node names", parsedYaml.names.join(","), "n1,n2");
equal("yaml rules kept", parsedYaml.rules.length, 2);
equal("pseudo nodes dropped", parsedYaml.proxies.length, 2);

const bare = parseSubscription("- {name: solo, type: vmess, server: 9.9.9.9, port: 443}");
equal("bare list parsed", bare.names.join(","), "solo");

const wrapped = parseSubscription(Buffer.from(yamlBody, "utf8").toString("base64"));
equal("base64-wrapped parsed", wrapped.names.join(","), "n1,n2");

await expectThrow("garbage subscription rejected", async () => parseSubscription("<<<not yaml at all"), /既不是 YAML/);

// ---------------------------------------------------------------------------
section("route.decideRoute");
const upstreamProxy = { mode: "subscription", reason: "test", engine, available: true, proxy: CORE, nodeName: "n1", nodeType: "ss" };
const upstreamNoExit = { mode: "subscription", reason: "0 nodes", engine, available: false, proxy: null, nodeName: null, nodeType: null };
const upstreamNone = { mode: "none", reason: "nothing configured", engine: null, available: false, proxy: null, nodeName: null, nodeType: null };

equal("foreign → proxy", decideRoute("https://github.com/x", upstreamProxy).route, "proxy");
equal("domestic → direct", decideRoute("https://www.baidu.com/x", upstreamProxy).route, "direct");
equal("loopback literal → direct", decideRoute(`${ORIGIN}/payload.bin`, upstreamProxy).route, "direct");
equal("localhost name → direct", decideRoute("http://localhost:8080/x", upstreamProxy).route, "direct");
equal("private IPv6 → direct", decideRoute("http://[::1]:9/x", upstreamProxy).route, "direct");
equal("force_route=proxy on loopback still direct", decideRoute(`${ORIGIN}/x`, upstreamProxy, "proxy").route, "direct");
equal("force_route=direct on a foreign host", decideRoute("https://github.com/x", upstreamProxy, "direct").route, "direct");
check("no upstream => warning + direct", decideRoute("https://github.com/x", upstreamNone).route === "direct");
check("no upstream sets a warning", typeof decideRoute("https://github.com/x", upstreamNone).warning === "string");
await expectThrow("foreign with a dead core throws NoUpstreamError", async () => decideRoute("https://github.com/x", upstreamNoExit), /没有可用节点/);
await expectThrow("non-http URL rejected", async () => decideRoute("file:///etc/passwd", upstreamProxy), /不是 http\/https/);

// a real NoUpstreamError instance carries a hint
try {
	decideRoute("https://github.com/x", upstreamNoExit);
} catch (error) {
	check("NoUpstreamError carries a hint", error instanceof NoUpstreamError && typeof error.hint === "string");
}

// ---------------------------------------------------------------------------
section("http client");
const directFlow = await httpFlow(`${ORIGIN}/payload.bin`, {});
equal("direct GET status", directFlow.status, 200);
equal("direct GET body length", (await readAll(directFlow)).length, PAYLOAD.length);

const proxiedFlow = await httpFlow(`${ORIGIN}/payload.bin`, { proxy: CORE });
equal("proxied GET status", proxiedFlow.status, 200);
equal("proxied GET body length", (await readAll(proxiedFlow)).length, PAYLOAD.length);

const redirected = await httpFlow(`${ORIGIN}/redirect`, { proxy: CORE });
equal("redirect followed", redirected.status, 200);
equal("redirect counted", redirected.redirects, 1);
await readAll(redirected);

await expectThrow("redirect loop bounded", async () => {
	const flow = await httpFlow(`${ORIGIN}/redirect-loop`, { maxRedirects: 3 });
	await readAll(flow);
}, /重定向次数超过上限/);

async function readAll(flow) {
	const chunks = [];
	for await (const chunk of flow.res) chunks.push(chunk);
	return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
section("end-to-end download through the rule core");
const target = path.join(tmpRoot, "out", "payload.bin");
const result = await attemptDownload({ url: `${ORIGIN}/payload.bin`, savePath: target, proxy: CORE, maxBytes: 8 * 1024 * 1024 });
equal("bytes match", result.bytes, PAYLOAD.length);
equal("sha256 matches the fixture", result.sha256, PAYLOAD_SHA);
check("file exists", fs.existsSync(target));
equal("file size on disk", fs.statSync(target).size, PAYLOAD.length);
check("no .part left behind", !fs.existsSync(`${target}.part`));
check("speed reported", typeof result.speedBps === "number" && result.speedBps > 0);
equal("redirects reported", result.http.redirects, 0);

const redirectedDownload = await attemptDownload({ url: `${ORIGIN}/redirect`, savePath: path.join(tmpRoot, "redirected.bin"), proxy: CORE, maxBytes: 8 * 1024 * 1024 });
equal("redirected download sha256", redirectedDownload.sha256, PAYLOAD_SHA);
equal("redirected download hop count", redirectedDownload.http.redirects, 1);

const named = await attemptDownload({ url: `${ORIGIN}/named`, savePath: path.join(tmpRoot, "named.bin"), proxy: CORE });
equal("content-disposition name is visible to callers", pickFilename(`${ORIGIN}/named`, { "content-disposition": "attachment; filename=\"report final.zip\"" }), "report final.zip");
equal("named download bytes", named.bytes, 2);

await expectThrow("exists without overwrite", async () => attemptDownload({ url: `${ORIGIN}/payload.bin`, savePath: target, proxy: CORE }), /目标文件已存在/);
const overwritten = await attemptDownload({ url: `${ORIGIN}/payload.bin`, savePath: target, proxy: CORE, overwrite: true });
equal("overwrite succeeds", overwritten.sha256, PAYLOAD_SHA);

const smallTarget = path.join(tmpRoot, "too-small.bin");
await expectThrow("size cap aborts mid-stream", async () => attemptDownload({ url: `${ORIGIN}/chunked`, savePath: smallTarget, proxy: CORE, maxBytes: 1024 }), /超过配置的大小上限/);
check("size cap removed the .part", !fs.existsSync(`${smallTarget}.part`));
check("size cap left no file", !fs.existsSync(smallTarget));

const declaredTarget = path.join(tmpRoot, "declared-too-big.bin");
await expectThrow("declared content-length is refused early", async () => attemptDownload({ url: `${ORIGIN}/too-big`, savePath: declaredTarget, proxy: CORE, maxBytes: 1024 }), /服务端声明大小/);
check("declared-too-big left no .part", !fs.existsSync(`${declaredTarget}.part`));

const missingTarget = path.join(tmpRoot, "missing.bin");
await expectThrow("HTTP 404 becomes an error", async () => attemptDownload({ url: `${ORIGIN}/missing`, savePath: missingTarget, proxy: CORE }), /HTTP 404/);
check("404 left no .part", !fs.existsSync(`${missingTarget}.part`));

check("HttpStatusError is used for status failures", await (async () => {
	try {
		await attemptDownload({ url: `${ORIGIN}/missing`, savePath: missingTarget, proxy: CORE });
		return false;
	} catch (error) {
		return error instanceof HttpStatusError && error.status === 404;
	}
})());

// ---------------------------------------------------------------------------
section("tool payload shape (camelCase/snake_case boundary)");
const { __internals } = await import("../lib/index.js");
const asText = (blocks) => blocks.map((block) => block.text).join("\n");

// Regression: attemptDownload must hand back snake_case http keys, because the
// tool renderers read `content_length`. A camelCase leak here printed
// "declared NaN B" at the model.
check("attemptDownload http keys are snake_case", result.http.content_length === PAYLOAD.length, `got ${JSON.stringify(result.http)}`);
check("attemptDownload http camelCase is absent", result.http.contentLength === undefined);

const downloadReport = asText(__internals.renderDownload({
	ok: true,
	saved_to: "D:\\dl\\a.zip",
	bytes: 102400,
	sha256: "abc",
	speed_bps: 51200,
	elapsed_ms: 2000,
	route: "proxy",
	route_reason: "rule engine matched github.com as proxied",
	fallback_used: false,
	upstream: { mode: "subscription", node: "JP-01", node_type: "trojan" },
	http: { status: 200, redirects: 1, content_length: null, content_type: "application/zip" },
	warnings: []
}));
check("download report has no undefined", !downloadReport.includes("undefined"), downloadReport);
check("download report has no NaN", !downloadReport.includes("NaN"), downloadReport);
check("download report keeps the route reason", downloadReport.includes("github.com"));
check("download report shows the node", downloadReport.includes("JP-01"));

const withLength = asText(__internals.renderDownload({
	ok: true, bytes: 102400, elapsed_ms: 1000, speed_bps: 102400, saved_to: "x", sha256: "y",
	route: "direct", route_reason: "r", fallback_used: false, upstream: null,
	http: { status: 200, redirects: 0, content_length: 102400 }, warnings: []
}));
check("declared length renders as a size", withLength.includes("声明大小 100 KB"), withLength);

const minimal = asText(__internals.renderDownload({ ok: true }));
check("a sparse success payload still renders", !minimal.includes("undefined") && !minimal.includes("NaN"), minimal);

const statusReport = asText(__internals.renderStatus({
	state: "running", error: null, mode: "subscription", reason: "3 nodes ready", enabled: true, port: 8080,
	node_count: 3, unsupported_nodes: 1, native_connector: false, native_nodes: 0, selected: null,
	group_type: "url-test", domestic_direct: true, subscription_url_set: true, proxy_url_set: false,
	env_proxy: null, last_subscription_update: null, latency_test_url: "u", auto_update_hours: 24,
	data_dir: "d", traffic: {}, groups: [],
	nodes: [{ name: "JP-01", type: "trojan", delay: 120, alive: true, needs_native: false }],
	notes: []
}));
check("status report has no undefined", !statusReport.includes("undefined"), statusReport);
check("status report has no NaN", !statusReport.includes("NaN"), statusReport);
check("status report shows the node count", statusReport.includes("节点数：3"), statusReport);
check("status report lists the node with its delay", statusReport.includes("JP-01 [trojan] 120ms"), statusReport);
check("status report localizes the state and mode", statusReport.includes("running（运行中）") && statusReport.includes("subscription（自包含订阅）"), statusReport);
check("download report localizes the upstream mode", downloadReport.includes("subscription（自包含订阅）"), downloadReport);

const geoReport = asText(__internals.renderGeo({
	input: "github.com", host: "github.com", route: "proxy", reason: "foreign", resolved_ips: ["1.2.3.4"],
	geo: { ip: "1.2.3.4", country: "United States", country_code: "US", isp: "x", provider: "ip-api.com" },
	geo_source: "online GeoIP (ip-api.com)", proxy_available: true, proxy_mode: "subscription",
	ping: { icmp: { ok: true, time_ms: 20 }, tcp_443: { ok: true, time_ms: 15 } }, advice: "proxied"
}));
check("geo report has no undefined", !geoReport.includes("undefined"), geoReport);
check("geo report includes the country code", geoReport.includes("US"));
check("geo report renders both probes", geoReport.includes("icmp=20ms") && geoReport.includes("tcp=15ms"));

const geoBare = asText(__internals.renderGeo({
	input: "h", host: "h", route: "direct", reason: "r", resolved_ips: [], geo: null, geo_source: null,
	proxy_available: false, proxy_mode: "none", ping: null, advice: null
}));
check("a geo verdict without DNS still renders", !geoBare.includes("undefined") && geoBare.includes("（无）"), geoBare);

check("plain() unwraps a Volatile-like container", __internals.plain({ a: { get: () => 1 } }).a.get() === 1);

const stallTarget = path.join(tmpRoot, "stall.bin");
await expectThrow("stall detector aborts", async () => attemptDownload({ url: `${ORIGIN}/slow`, savePath: stallTarget, proxy: CORE, stallS: 3, timeoutS: 30 }), /下载停滞/);
check("stall left no .part", !fs.existsSync(`${stallTarget}.part`));

const cancelTarget = path.join(tmpRoot, "cancel.bin");
const controller = new AbortController();
setTimeout(() => controller.abort(), 150);
await expectThrow("caller cancellation aborts", async () => attemptDownload({ url: `${ORIGIN}/slow`, savePath: cancelTarget, proxy: CORE, stallS: 60, timeoutS: 60, signal: controller.signal }), /已取消/);
check("cancellation left no .part", !fs.existsSync(`${cancelTarget}.part`));

// ---------------------------------------------------------------------------
section("AI platform protection");
const { AI_DIRECT_DOMAINS, composeDirectDomains, directRuleLines, normalizeDomain } = await import("../lib/core/ai-domains.js");

check("every built-in AI domain is a usable bare suffix", AI_DIRECT_DOMAINS.every((d) => d === d.toLowerCase() && d.includes(".") && !/[\/\s]/.test(d)));
check("the AI domain list has no duplicates", new Set(AI_DIRECT_DOMAINS).size === AI_DIRECT_DOMAINS.length);
check("the list covers the majors", ["deepseek.com", "bigmodel.cn", "moonshot.cn", "dashscope.aliyuncs.com", "volces.com", "minimax.chat"].every((d) => AI_DIRECT_DOMAINS.includes(d)));

equal("normalizeDomain strips scheme, case and path", normalizeDomain("HTTPS://API.Example.COM/v1/models"), "api.example.com");
equal("normalizeDomain strips a wildcard", normalizeDomain("*.example.com"), "example.com");
equal("normalizeDomain rejects junk", normalizeDomain("not a domain"), "");
equal("normalizeDomain rejects a bare word", normalizeDomain("localhost"), "");

const composed = composeDirectDomains({ protectAiPlatforms: true, extraDirectDomains: ["https://api.mycorp.example/v1", "*.extra.cn"] });
check("composeDirectDomains keeps the built-ins", composed.includes("deepseek.com"));
check("composeDirectDomains normalizes a user URL", composed.includes("api.mycorp.example"));
check("composeDirectDomains normalizes a user wildcard", composed.includes("extra.cn"));
check("protectAiPlatforms=false drops the built-ins", !composeDirectDomains({ protectAiPlatforms: false }).includes("deepseek.com"));

// The core promise: AI platforms stay direct even when everything else is proxied.
const allProxyUnprotected = new RuleEngine({ extraRules: ["MATCH,PROXY"] });
equal("without protection everything is proxied", allProxyUnprotected.decide("api.deepseek.com"), "proxy");

const allProxyGuarded = new RuleEngine({ extraRules: [...directRuleLines(composeDirectDomains({})), "MATCH,PROXY"] });
equal("deepseek stays direct under MATCH,PROXY", allProxyGuarded.decide("api.deepseek.com"), "direct");
equal("the deepseek apex is direct too", allProxyGuarded.decide("deepseek.com"), "direct");
equal("bigmodel stays direct", allProxyGuarded.decide("open.bigmodel.cn"), "direct");
equal("moonshot stays direct", allProxyGuarded.decide("api.moonshot.cn"), "direct");
equal("dashscope stays direct", allProxyGuarded.decide("dashscope.aliyuncs.com"), "direct");
equal("volces stays direct", allProxyGuarded.decide("ark.cn-beijing.volces.com"), "direct");
equal("kimi stays direct", allProxyGuarded.decide("api.kimi.com"), "direct");
equal("a foreign host is still proxied", allProxyGuarded.decide("github.com"), "proxy");
equal("an unrelated domestic host is still proxied under MATCH,PROXY", allProxyGuarded.decide("www.baidu.com"), "proxy");

// Protection outranks a user rule that comes later.
const userTriedToProxy = new RuleEngine({ extraRules: [...directRuleLines(composeDirectDomains({})), "DOMAIN-SUFFIX,deepseek.com,PROXY"] });
equal("protection outranks a later user rule", userTriedToProxy.decide("api.deepseek.com"), "direct");

// ---------------------------------------------------------------------------
section("session guard (NO_PROXY in $DSH_HOME/.env)");
const guard = await import("../lib/core/session-guard.js");

equal("splitEntries splits on commas and whitespace", guard.splitEntries("a.com, b.com  c.com").join("|"), "a.com|b.com|c.com");
equal("readNoProxy finds the value", guard.readNoProxy("FOO=1\nNO_PROXY=a.com,b.com\n"), "a.com,b.com");
equal("readNoProxy is case-insensitive", guard.readNoProxy("no_proxy=x.com"), "x.com");
equal("readNoProxy returns empty when absent", guard.readNoProxy("FOO=1"), "");
equal("missingDomains accepts the dot form", guard.missingDomains(".deepseek.com", ["deepseek.com"]).length, 0);
equal("missingDomains reports gaps", guard.missingDomains("a.com", ["a.com", "b.com"]).join(","), "b.com");
equal("composeNoProxy preserves existing order", guard.composeNoProxy("z.com", ["a.com"]).split(",")[0], "z.com");
check("composeNoProxy emits both spellings", guard.composeNoProxy("", ["a.com"]).includes("a.com,.a.com"));
check("composeNoProxy adds loopback", guard.composeNoProxy("", []).includes("127.0.0.1"));
equal("composeNoProxy keeps a wildcard", guard.composeNoProxy("*", ["a.com"]), "*");
check("missingDomains yields nothing under a wildcard", guard.missingDomains("*", ["a.com"]).length === 0);
check("envFilePath ends in .env", guard.envFilePath("H:/tmp/home").endsWith(".env"));

const baseEnv = "FOO=bar\nHTTPS_PROXY=http://127.0.0.1:7890\nno_proxy=localhost\n";
const merged = guard.upsertNoProxy(baseEnv, "localhost,deepseek.com");
check("upsertNoProxy rewrites the existing line", merged.includes("NO_PROXY=localhost,deepseek.com"), merged);
check("upsertNoProxy keeps unrelated lines", merged.includes("FOO=bar") && merged.includes("HTTPS_PROXY=http://127.0.0.1:7890"));
check("upsertNoProxy does not duplicate the key", (merged.match(/no_proxy/gi) || []).length === 1);
check("upsertNoProxy preserves CRLF", guard.upsertNoProxy("A=1\r\nNO_PROXY=x\r\n", "y").includes("\r\n"));
check("upsertNoProxy appends when absent", guard.upsertNoProxy("A=1\n", "x").includes("NO_PROXY=x"));

const guardDir = path.join(tmpRoot, "guard");
const guardEnv = path.join(guardDir, ".env");
const guardDomains = ["deepseek.com", "bigmodel.cn"];
const countProxyVars = (text) => (text.match(/^\s*https?_proxy\s*=/gim) || []).length;
fs.mkdirSync(guardDir, { recursive: true });
fs.writeFileSync(guardEnv, "HTTPS_PROXY=http://127.0.0.1:7890\nNO_PROXY=localhost\n", "utf8");

const guardBefore = guard.inspectGuard({ envPath: guardEnv, domains: guardDomains });
check("inspect sees the gap", guardBefore.covered === false && guardBefore.missing.length === 2, JSON.stringify(guardBefore));
check("inspect lists the proxy var", guardBefore.proxy_vars.join(",") === "HTTPS_PROXY");
check("inspect suggests a line", guardBefore.suggested_line.startsWith("NO_PROXY="));

const applied = guard.applyGuard({ envPath: guardEnv, domains: guardDomains });
check("apply reports a change", applied.changed === true);
check("apply wrote a backup", applied.backupPath !== null && fs.existsSync(applied.backupPath));
check("apply added exactly the missing domains", applied.added.length === 2);

const afterText = fs.readFileSync(guardEnv, "utf8");
check("apply never adds a second proxy var", countProxyVars(afterText) === countProxyVars("HTTPS_PROXY=http://127.0.0.1:7890\nNO_PROXY=localhost\n"));
check("apply kept the original proxy value", afterText.includes("HTTPS_PROXY=http://127.0.0.1:7890"));

const guardAfter = guard.inspectGuard({ envPath: guardEnv, domains: guardDomains });
check("the guard is satisfied after apply", guardAfter.covered === true, JSON.stringify(guardAfter));
check("a second apply is a no-op", guard.applyGuard({ envPath: guardEnv, domains: guardDomains }).changed === false);

guard.restoreGuard({ envPath: guardEnv });
const restoredText = fs.readFileSync(guardEnv, "utf8");
check("restore brings the original NO_PROXY back", restoredText.includes("NO_PROXY=localhost") && !restoredText.includes("deepseek.com"));
check("restore leaves the proxy var alone", restoredText.includes("HTTPS_PROXY=http://127.0.0.1:7890"));
await expectThrow("restore without a backup fails loudly", async () => guard.restoreGuard({ envPath: path.join(guardDir, "missing.env") }), /找不到可还原的备份/);

const guardReport = asText(__internals.renderGuard({
	action: "apply", env_path: guardEnv, exists: true, proxy_vars: ["HTTPS_PROXY"], no_proxy: "localhost,deepseek.com",
	no_proxy_line: "NO_PROXY=localhost,deepseek.com", covered: true, missing_count: 0, protected_domain_count: 41,
	protected_domains: [], changed: true, added_count: 82, backup_path: "x.bak", restored: false, notes: []
}));
check("guard report has no undefined", !guardReport.includes("undefined"), guardReport);
check("guard report mentions the backup", guardReport.includes("备份：x.bak"));
check("guard report localizes the action", guardReport.includes("apply（写入 NO_PROXY）"), guardReport);

// ---------------------------------------------------------------------------
section("client bundle and patch metadata");
const vm = await import("node:vm");
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const clientSource = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const patchSource = fs.readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");
const entryId = pkg.name.split("/").pop();

const bundleId = /id:\s*'([^']+)'/.exec(clientSource);
// Strip comments so these assertions test real code, not prose about the code.
const clientCode = clientSource
	.replace(/\/\*[\s\S]*?\*\//g, "")
	.split(/\r?\n/)
	.map((line) => line.replace(/\/\/.*$/, ""))
	.join("\n");

equal("the bundle id equals the package name", bundleId === null ? null : bundleId[1], pkg.name);
check("cordis.patch.yml references the package name", patchSource.includes(pkg.name));
check("cordis.patch.yml uses the matching entry id", patchSource.includes(`id: ${entryId}`));
check("the entry id matches the host half", entryId === "dsh-downloader");
check("the client registers a settings section", clientCode.includes("'settings.section'"));
check("the client resolves configForms lazily", clientCode.includes("ctx.get('configForms')"));
check("the client does not use the removed settingsScope", !clientCode.includes("settingsScope"));
check("the client wraps scope.subscribe to keep `this`", clientCode.includes("function (listener) { return scope.subscribe(listener) }"));
check("the client wraps scope.getSnapshot to keep `this`", clientCode.includes("function () { return scope.getSnapshot() }"));

let clientCompiles = true;
let compileError = "";
try {
	new vm.Script(clientSource, { filename: "lib/client.js" });
} catch (error) {
	clientCompiles = false;
	compileError = error instanceof Error ? error.message : String(error);
}
check("the client bundle compiles as a script", clientCompiles, compileError);
check("the patch ships with the package", Array.isArray(pkg.files) && pkg.files.includes("cordis.patch.yml"));
check("the size data ships with the package", Array.isArray(pkg.files) && pkg.files.includes("lib"));

// ---------------------------------------------------------------------------
section("teardown");
core.stop();
server.closeAllConnections?.();
await new Promise((resolve) => server.close(() => resolve()));
check("core port released", await new Promise((resolve) => {
	const probe = http.request({ host: "127.0.0.1", port: corePort, path: "/", method: "GET" }, () => resolve(false));
	probe.once("error", () => resolve(true));
	probe.end();
}));
fs.rmSync(tmpRoot, { recursive: true, force: true });

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
	console.log("failed checks:");
	for (const label of failures) console.log(`  - ${label}`);
}
process.exit(failed === 0 ? 0 : 1);
