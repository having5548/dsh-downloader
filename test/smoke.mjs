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
import nodeNet from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { RuleEngine } from "../lib/core/rules.js";
import { ProxyServer } from "../lib/core/proxy-server.js";
import { parseSubscription } from "../lib/core/subscription.js";
import { decideRoute, NoUpstreamError } from "../lib/download/route.js";
import { attemptDownload, HttpStatusError } from "../lib/download/fetch-file.js";
import { connectTunnel, httpFlow, parseProxyUrl } from "../lib/download/http.js";
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
// Above SEGMENT_MIN_TOTAL (1 MiB) so the segmented path actually engages.
const BIG_PAYLOAD = randomBytes(3 * 1024 * 1024 + 12345);
const BIG_SHA = createHash("sha256").update(BIG_PAYLOAD).digest("hex");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dshdl-smoke-"));

/** 解析测试夹具用的 `Range: bytes=start-end`。 */
function fixtureSlice(req, length) {
	const raw = req.headers.range;
	if (typeof raw !== "string") return null;
	const match = /^bytes=(\d+)-(\d*)$/.exec(raw.trim());
	if (match === null) return { invalid: true };
	const start = Number(match[1]);
	const end = match[2].length > 0 ? Number(match[2]) : length - 1;
	if (start >= length || end >= length || start > end) return { invalid: true };
	return { start, end };
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	switch (url.pathname) {
		case "/payload.bin":
			res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(PAYLOAD.length) });
			res.end(PAYLOAD);
			return;
		case "/big.bin": {
			// Honest range server: advertises and honours Accept-Ranges.
			const slice = fixtureSlice(req, BIG_PAYLOAD.length);
			if (slice !== null && slice.invalid === true) {
				res.writeHead(416, { "content-range": `bytes */${BIG_PAYLOAD.length}` });
				res.end();
				return;
			}
			if (slice === null) {
				res.writeHead(200, {
					"content-type": "application/octet-stream",
					"content-length": String(BIG_PAYLOAD.length),
					"accept-ranges": "bytes"
				});
				res.end(BIG_PAYLOAD);
				return;
			}
			res.writeHead(206, {
				"content-type": "application/octet-stream",
				"content-length": String(slice.end - slice.start + 1),
				"content-range": `bytes ${slice.start}-${slice.end}/${BIG_PAYLOAD.length}`,
				"accept-ranges": "bytes"
			});
			res.end(BIG_PAYLOAD.subarray(slice.start, slice.end + 1));
			return;
		}
		case "/liar.bin":
			// Claims range support but always answers 200 with the whole body: the
			// segmented attempt must notice and fall back instead of corrupting.
			res.writeHead(200, {
				"content-type": "application/octet-stream",
				"content-length": String(BIG_PAYLOAD.length),
				"accept-ranges": "bytes"
			});
			res.end(BIG_PAYLOAD);
			return;
		case "/named":
			res.writeHead(200, { "content-disposition": 'attachment; filename="report final.zip"' });
			res.end("ok");
			return;
		case "/redirect":
			res.writeHead(302, { location: "/payload.bin" });
			res.end();
			return;
		case "/echo-auth":
			res.writeHead(200, { "content-type": "text/plain" });
			res.end(`auth=${req.headers.authorization ?? "none"} keep=${req.headers["x-keep"] ?? "none"}`);
			return;
		case "/auth-same-redirect":
			res.writeHead(302, { location: "/echo-auth" });
			res.end();
			return;
		case "/auth-cross-redirect":
			res.writeHead(302, { location: `${AUTH_PROBE_ORIGIN}/echo-auth` });
			res.end();
			return;
		case "/needs-auth": {
			if ((req.headers.authorization ?? "") !== "Bearer test-token") {
				res.writeHead(401, { "content-type": "text/plain" });
				res.end("unauthorized");
				return;
			}
			// 鉴权 + 支持 Range，用来验证分片请求也会带上凭据头。
			const slice = fixtureSlice(req, BIG_PAYLOAD.length);
			if (slice === null) {
				res.writeHead(200, {
					"content-type": "application/octet-stream",
					"content-length": String(BIG_PAYLOAD.length),
					"accept-ranges": "bytes"
				});
				res.end(BIG_PAYLOAD);
				return;
			}
			res.writeHead(206, {
				"content-type": "application/octet-stream",
				"content-length": String(slice.end - slice.start + 1),
				"content-range": `bytes ${slice.start}-${slice.end}/${BIG_PAYLOAD.length}`,
				"accept-ranges": "bytes"
			});
			res.end(BIG_PAYLOAD.subarray(slice.start, slice.end + 1));
			return;
		}
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

// 第二台服务器：只用来验证跨域重定向会不会把凭据头带过去（host:port 不同即算跨域）。
const authProbe = http.createServer((req, res) => {
	res.writeHead(200, { "content-type": "text/plain" });
	res.end(`auth=${req.headers.authorization ?? "none"} keep=${req.headers["x-keep"] ?? "none"}`);
});
await new Promise((resolve) => authProbe.listen(0, "127.0.0.1", resolve));
const AUTH_PROBE_ORIGIN = `http://127.0.0.1:${authProbe.address().port}`;

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

const profilesReport = asText(__internals.renderProfiles({
	action: "list",
	current_label: "机场 A",
	profiles: [
		{
			id: "1", label: "机场 A", source: "url", current: true, auto_update: true, auto_update_hours: 24,
			last_update_at: Date.now(), node_count: 12,
			subscription_info: { upload: 1024, download: 2048, total: 107374182400, expire: 1798761600 }
		},
		{
			id: "2", label: "本地.yaml", source: "file", current: false, auto_update: false, auto_update_hours: 24,
			last_update_at: Date.now(), node_count: null, subscription_info: null
		}
	],
	notes: []
}));
check("profiles report has no undefined", !profilesReport.includes("undefined"), profilesReport);
check("profiles report marks the current profile", profilesReport.includes("当前"), profilesReport);
check("profiles report explains file profiles", profilesReport.includes("本地文件不自动更新"), profilesReport);
check("profiles report renders traffic and expiry", profilesReport.includes("已用") && profilesReport.includes("到期"), profilesReport);
check("profiles report only counts nodes for the active profile", profilesReport.includes("12 个节点") && !profilesReport.includes("? 个节点"), profilesReport);

const emptyProfiles = asText(__internals.renderProfiles({ action: "list", profiles: [], current_label: null, notes: [] }));
check("an empty profile list renders a hint", emptyProfiles.includes("还没有导入任何配置"), emptyProfiles);

// ---------------------------------------------------------------------------
section("分享链接订阅（hysteria2 / ss / trojan / vmess / vless）");
const links = await import("../lib/core/share-links.js");

const hy2 = links.parseShareLink(
	"hysteria2://6a4630d9-9752-4531-95eb-e7385b0e9f1a@example.com:32738?sni=example.com&insecure=0&obfs=salamander&obfs-password=secret16chars%3D%3D#%E6%97%A5%E6%9C%AC01"
);
equal("hysteria2 name is decoded", hy2.name, "日本01");
equal("hysteria2 type", hy2.type, "hysteria2");
equal("hysteria2 password", hy2.password, "6a4630d9-9752-4531-95eb-e7385b0e9f1a");
equal("hysteria2 sni", hy2.sni, "example.com");
equal("hysteria2 port", hy2.port, 32738);
equal("hysteria2 obfs", hy2.obfs, "salamander");
equal("hysteria2 obfs-password is url-decoded", hy2["obfs-password"], "secret16chars==");
check("hysteria2 insecure=0 keeps verification on", hy2["skip-cert-verify"] === undefined);
check("hy2:// is accepted too", links.parseShareLink("hy2://pw@a.com:443#x").type === "hysteria2");
check("hysteria2 insecure=1 turns verification off", links.parseShareLink("hysteria2://pw@a.com:443?insecure=1#x")["skip-cert-verify"] === true);

const ssBase64 = links.parseShareLink(`ss://${Buffer.from("aes-128-gcm:pass123").toString("base64")}@1.2.3.4:8388#SS%E8%8A%82%E7%82%B9`);
equal("ss userinfo-base64 cipher", ssBase64.cipher, "aes-128-gcm");
equal("ss userinfo-base64 password", ssBase64.password, "pass123");
equal("ss name is decoded", ssBase64.name, "SS节点");
const ssWhole = links.parseShareLink(`ss://${Buffer.from("chacha20-ietf-poly1305:pw@5.6.7.8:443").toString("base64")}#whole`);
equal("ss whole-authority form", `${ssWhole.server}:${ssWhole.port}`, "5.6.7.8:443");
equal("ss whole-authority cipher", ssWhole.cipher, "chacha20-ietf-poly1305");
const ssPlugin = links.parseShareLink("ss://YWVzOnB3@1.2.3.4:1?plugin=obfs-local#x");
check("ss with a plugin is flagged unsupported", ssPlugin !== null && typeof ssPlugin.__unsupported === "string", JSON.stringify(ssPlugin));
const ssPluginList = links.parseShareLinkList("ss://YWVzOnB3@1.2.3.4:1?plugin=obfs-local#x\ntrojan://p@h.example:443#keep");
check("the list parser drops an ss with a plugin and keeps the rest", ssPluginList.proxies.length === 1 && ssPluginList.skipped.length === 1, JSON.stringify(ssPluginList.skipped));

const trojan = links.parseShareLink("trojan://mypass@t.example.com:443?sni=t.example.com&type=ws&path=%2Fws&host=t.example.com&allowInsecure=1#TROJAN");
equal("trojan password", trojan.password, "mypass");
equal("trojan network", trojan.network, "ws");
equal("trojan ws path is decoded", trojan["ws-opts"].path, "/ws");
equal("trojan ws Host header", trojan["ws-opts"].headers.Host, "t.example.com");
check("trojan allowInsecure maps to skip-cert-verify", trojan["skip-cert-verify"] === true);

const vmessJson = { v: "2", ps: "VMESS节点", add: "v.example.com", port: "443", id: "11111111-2222-3333-4444-555555555555", aid: "0", scy: "auto", net: "ws", host: "v.example.com", path: "/vm", tls: "tls", sni: "v.example.com" };
const vmess = links.parseShareLink(`vmess://${Buffer.from(JSON.stringify(vmessJson)).toString("base64")}`);
equal("vmess name comes from ps", vmess.name, "VMESS节点");
equal("vmess uuid", vmess.uuid, "11111111-2222-3333-4444-555555555555");
equal("vmess alterId", vmess.alterId, 0);
check("vmess tls", vmess.tls === true);
equal("vmess servername", vmess.servername, "v.example.com");
equal("vmess ws path", vmess["ws-opts"].path, "/vm");

const vless = links.parseShareLink("vless://uuid-here@r.example.com:443?encryption=none&security=reality&sni=r.example.com&fp=chrome&pbk=PUBKEY&sid=abcd&flow=xtls-rprx-vision&type=tcp#REALITY");
check("vless tls is on for reality", vless.tls === true);
equal("vless reality public-key", vless["reality-opts"]["public-key"], "PUBKEY");
equal("vless reality short-id", vless["reality-opts"]["short-id"], "abcd");
equal("vless flow", vless.flow, "xtls-rprx-vision");
equal("vless fingerprint", vless["client-fingerprint"], "chrome");
check("vless reality without pbk is skipped", links.parseShareLink("vless://u@a.com:443?security=reality#x") === null);

const socksNode = links.parseShareLink("socks5://user:pw@127.0.0.1:1080#S");
equal("socks5 type", socksNode.type, "socks5");
equal("socks5 username", socksNode.username, "user");
check("http node works", links.parseShareLink("http://u:p@h.example:8080#H").type === "http");
check("an unknown scheme is rejected", links.parseShareLink("tuic://x@a.com:443#t") === null);
check("a non-link line is rejected", links.parseShareLink("just some text") === null);
check("a link without a port is rejected", links.parseShareLink("trojan://pw@noport#x") === null);

const plainList = ["hysteria2://a@h1.com:443#N1", "trojan://b@h2.com:443#N2", "# a comment", "", "garbage"].join("\n");
const parsedPlain = links.parseShareLinkList(plainList);
equal("a plain list parses its nodes", parsedPlain.proxies.length, 2);
equal("a plain list keeps order", parsedPlain.names.join(","), "N1,N2");
equal("a plain list reports the junk line (comments and blanks are filtered first)", parsedPlain.skipped.length, 1);
const b64List = Buffer.from(["trojan://b@h2.com:443#Only", "ss://YWVzOnB3@3.3.3.3:80#Two"].join("\n")).toString("base64");
const parsedB64 = links.parseShareLinkList(b64List);
equal("a base64-wrapped list parses", parsedB64.proxies.length, 2);
check("an empty list returns null", links.parseShareLinkList("") === null);

// 端到端：parseSubscription 必须能直接吃这种订阅
const subFromLinks = parseSubscription(b64List);
equal("parseSubscription reports the share-link kind", subFromLinks.kind, "share-links");
equal("parseSubscription reads the nodes", subFromLinks.names.length, 2);
equal("parseSubscription returns no rules for a link list", subFromLinks.rules.length, 0);
const yamlSub = parseSubscription("proxies:\n  - {name: Y, type: ss, server: 1.2.3.4, port: 1, cipher: aes-128-gcm, password: p}\n");
equal("a YAML subscription still reports the yaml kind", yamlSub.kind, "yaml");
let unsupportedSubThrew = false;
try {
	parseSubscription("this is neither yaml nor links");
} catch {
	unsupportedSubThrew = true;
}
check("an unrecognizable body still throws", unsupportedSubThrew);

// ---------------------------------------------------------------------------
section("多线程（分片）下载");
const segmented = await import("../lib/download/segmented.js");

check("a 206 counts as range-capable", segmented.supportsRanges(206, {}) === true);
check("Accept-Ranges: bytes counts as range-capable", segmented.supportsRanges(200, { "accept-ranges": "bytes" }) === true);
check("a plain 200 without the header does not", segmented.supportsRanges(200, {}) === false);
check("Accept-Ranges: none does not", segmented.supportsRanges(200, { "accept-ranges": "none" }) === false);

const cr = segmented.parseContentRange("bytes 1048576-2097151/3145728");
equal("Content-Range start", cr.start, 1048576);
equal("Content-Range end", cr.end, 2097151);
equal("Content-Range total", cr.total, 3145728);
equal("Content-Range tolerates an unknown total", segmented.parseContentRange("bytes 0-9/*").total, null);
check("a malformed Content-Range is rejected", segmented.parseContentRange("bytes whatever") === null);

const planned = segmented.planChunks(4 * 1024 * 1024, 4);
equal("planChunks makes one chunk per thread", planned.length, 4);
equal("the first chunk starts at zero", planned[0].begin, 0);
equal("the last chunk ends at the last byte", planned[planned.length - 1].end, 4 * 1024 * 1024 - 1);
check("the chunks tile the file exactly", planned.reduce((sum, c) => sum + (c.end - c.begin + 1), 0) === 4 * 1024 * 1024);
equal("planChunks never exceeds the file size", segmented.planChunks(600 * 1024, 8).length, 1);
equal("remainingBytes sums the unclaimed parts", segmented.remainingBytes(planned), 4 * 1024 * 1024);

// 工作窃取：永远从剩余最多的 chunk 尾部切一半，小于两倍下限就整块交出去。
const stealChunks = [{ begin: 0, end: 999 }, { begin: 1000, end: 3 * 1024 * 1024 }];
const firstSteal = segmented.stealSlice(stealChunks);
equal("steal takes the front of the chunk with the most left", firstSteal.begin, 1000);
check("steal takes about half of it", firstSteal.end - firstSteal.begin + 1 >= segmented.STEAL_MIN_BYTES, JSON.stringify(firstSteal));
check("the victim chunk shrinks", stealChunks[1].end - stealChunks[1].begin + 1 < 3 * 1024 * 1024);
check("the small chunk is left alone", stealChunks[0].begin === 0 && stealChunks[0].end === 999);
const tinyChunks = [{ begin: 0, end: 1024 }];
const tinySteal = segmented.stealSlice(tinyChunks);
equal("a sub-minimum chunk is handed over whole", tinySteal.end, 1024);
check("the chunk is empty afterwards", segmented.stealSlice(tinyChunks) === null);
check("no work left returns null", segmented.stealSlice([]) === null);

const bigTarget = path.join(tmpRoot, "threaded", "big.bin");
const threaded = await attemptDownload({ url: `${ORIGIN}/big.bin`, savePath: bigTarget, threads: 4, maxBytes: 64 * 1024 * 1024 });
equal("threaded sha256 matches", threaded.sha256, BIG_SHA);
equal("threaded reports its segment count", threaded.segments, 4);
check("threaded took the multi-connection path", threaded.viaThreads === true);
equal("threaded byte count", threaded.bytes, BIG_PAYLOAD.length);

const threadedAgain = await attemptDownload({ url: `${ORIGIN}/big.bin`, savePath: bigTarget, threads: 8, overwrite: true, maxBytes: 64 * 1024 * 1024 });
equal("a different thread count still merges correctly", threadedAgain.sha256, BIG_SHA);

const singleTarget = path.join(tmpRoot, "threaded", "single.bin");
const single = await attemptDownload({ url: `${ORIGIN}/big.bin`, savePath: singleTarget, threads: 1, maxBytes: 64 * 1024 * 1024 });
equal("threads=1 stays on one connection", single.viaThreads, false);
equal("threads=1 still gets the right bytes", single.sha256, BIG_SHA);

// 服务端嘴上支持 Range、实际回整个 200：必须回退，不能拼出坏文件。
const liarTarget = path.join(tmpRoot, "threaded", "liar.bin");
const liar = await attemptDownload({ url: `${ORIGIN}/liar.bin`, savePath: liarTarget, threads: 4, maxBytes: 64 * 1024 * 1024 });
check("a range-lying server falls back to one stream", liar.viaThreads === false);
equal("the fallback result is still byte-correct", liar.sha256, BIG_SHA);

// 同样的分片逻辑必须能穿过插件自己的代理内核。
const threadedProxyTarget = path.join(tmpRoot, "threaded", "via-core.bin");
const threadedProxy = await attemptDownload({ url: `${ORIGIN}/big.bin`, savePath: threadedProxyTarget, proxy: CORE, threads: 4, maxBytes: 64 * 1024 * 1024 });
equal("segmented download through the rule core", threadedProxy.sha256, BIG_SHA);
check("and it really was segmented", threadedProxy.viaThreads === true);

// ---------------------------------------------------------------------------
section("FlClash 式配置导入");
const profilesMod = await import("../lib/core/profiles.js");

const userinfo = profilesMod.parseSubscriptionUserinfo("upload=1024; download=2048; total=107374182400; expire=1798761600");
equal("userinfo upload", userinfo.upload, 1024);
equal("userinfo total", userinfo.total, 107374182400);
equal("userinfo expire", userinfo.expire, 1798761600);
equal("userinfo tolerates an empty header", profilesMod.parseSubscriptionUserinfo(null).total, 0);
equal("userinfo tolerates junk", profilesMod.parseSubscriptionUserinfo("nonsense; upload=x").upload, 0);

equal("parseImportLink plain url", profilesMod.parseImportLink("https://example.com/sub?token=1"), "https://example.com/sub?token=1");
equal(
	"parseImportLink clash install-config",
	profilesMod.parseImportLink("clash://install-config?url=https%3A%2F%2Fexample.com%2Fsub%3Ftoken%3D1"),
	"https://example.com/sub?token=1"
);
equal(
	"parseImportLink clash bare encoded",
	profilesMod.parseImportLink(`clash://${encodeURIComponent("https://example.com/a.yaml")}`),
	"https://example.com/a.yaml"
);
equal("parseImportLink rejects junk", profilesMod.parseImportLink("hello world"), null);
equal("parseImportLink rejects an empty clash link", profilesMod.parseImportLink("clash://install-config"), null);
equal("labelFromUrl uses the host", profilesMod.labelFromUrl("https://sub.example.com/x?y=1"), "sub.example.com");
equal("labelFromUrl strips www", profilesMod.labelFromUrl("https://www.example.com/x"), "example.com");

const profileYaml = [
	"proxies:",
	"  - {name: P1, type: ss, server: 1.2.3.4, port: 8388, cipher: aes-128-gcm, password: p}",
	"  - {name: P2, type: trojan, server: 5.6.7.8, port: 443, password: q}",
	"rules:",
	"  - MATCH,PROXY"
].join("\n");
check("validateConfigText accepts a usable body", profilesMod.validateConfigText(profileYaml).names.length === 2);
await expectThrow("validateConfigText rejects an empty body", async () => profilesMod.validateConfigText("   "), /配置内容为空/);
await expectThrow("validateConfigText rejects a node-less body", async () => profilesMod.validateConfigText("proxies: []"), /没有解析到任何节点/);

const profileDir = path.join(tmpRoot, "profiles");
const store = new profilesMod.ProfileStore({ dataDir: profileDir });
const fakeFetcher = async () => ({
	text: profileYaml,
	headers: {
		"content-disposition": "attachment; filename*=UTF-8''%E6%88%91%E7%9A%84%E8%AE%A2%E9%98%85.yaml",
		"subscription-userinfo": "upload=1; download=2; total=3; expire=4"
	}
});

const added = await store.addFromUrl("https://example.com/sub", { fetcher: fakeFetcher });
equal("addFromUrl takes the label from Content-Disposition", added.label, "我的订阅.yaml");
equal("addFromUrl stores the traffic info", added.subscriptionInfo.total, 3);
equal("addFromUrl becomes current when it is the first", store.current().id, added.id);
check("addFromUrl wrote the body", store.body(added.id).includes("P1"));

const fromFile = store.addFromFile("本地节点.yaml", profileYaml);
equal("addFromFile labels from the file name", fromFile.label, "本地节点");
equal("addFromFile is a file profile", fromFile.source, "file");
equal("addFromFile does not become current", store.current().id, added.id);
equal("list() reports two profiles", store.list().length, 2);
check("file profiles never auto-update", store.list().find((p) => p.id === fromFile.id).dueAt === null);
check("url profiles get a due time", typeof store.list().find((p) => p.id === added.id).dueAt === "number");

await expectThrow("a file profile cannot be updated from the network", async () => store.update(fromFile.id, { fetcher: fakeFetcher }), /本地文件配置不能从网络更新/);

store.select(fromFile.id);
equal("select switches the current profile", store.current().id, fromFile.id);
store.rename(fromFile.id, "改过的名字");
equal("rename persists", store.get(fromFile.id).label, "改过的名字");
equal("reorder puts the given ids first", store.reorder([added.id, fromFile.id])[0].id, added.id);
equal("dueProfiles is empty right after an update", store.dueProfiles().length, 0);
equal("dueProfiles finds the profile once its interval elapsed", store.dueProfiles(Date.now() + 25 * 3600 * 1000).length, 1);
store.setAutoUpdate(added.id, false);
equal("setAutoUpdate off removes it from the due list", store.dueProfiles(Date.now() + 25 * 3600 * 1000).length, 0);
await expectThrow("a file profile has no auto-update", async () => store.setAutoUpdate(fromFile.id, true), /没有自动更新/);

const updatedProfile = await store.update(added.id, { fetcher: fakeFetcher });
equal("update refreshes the traffic info", updatedProfile.subscriptionInfo.total, 3);

// A second store over the same directory sees the persisted state.
const reopened = new profilesMod.ProfileStore({ dataDir: profileDir });
equal("state survives a reopen", reopened.list().length, 2);
equal("the current selection survives a reopen", reopened.current().id, fromFile.id);
check("the metadata file exists", fs.existsSync(path.join(profileDir, "profiles.json")));

reopened.remove(added.id);
equal("remove drops the profile", reopened.list().length, 1);
check("remove deletes the body", !fs.existsSync(reopened.bodyPath(added.id)));
reopened.remove(fromFile.id);
equal("removing the last profile clears the selection", reopened.current(), null);
equal("removing the last profile empties the list", reopened.list().length, 0);

// ---------------------------------------------------------------------------
section("代理作用域：只服务本插件");
const gated = new ProxyServer({
	engine: { decide: () => "direct" },
	resolveNode: () => null,
	token: "test-token-123"
});
const gatedPort = await gated.start(0);
check("the gated core reports itself as gated", gated.gated === true);

const gatedTarget = path.join(tmpRoot, "gated.bin");
const gatedResult = await attemptDownload({
	url: `${ORIGIN}/payload.bin`,
	savePath: gatedTarget,
	proxy: { socks: false, host: "127.0.0.1", port: gatedPort, token: "test-token-123" },
	maxBytes: 8 * 1024 * 1024
});
equal("a caller holding the token downloads fine", gatedResult.sha256, PAYLOAD_SHA);

// Plain http goes through the absolute-form path, where a 407 is a normal response
// rather than a connection failure.
const refusedFlow = await httpFlow(`${ORIGIN}/payload.bin`, { proxy: { socks: false, host: "127.0.0.1", port: gatedPort } });
equal("a plain-http caller without the token gets 407", refusedFlow.status, 407);
await readAll(refusedFlow);

const wrongFlow = await httpFlow(`${ORIGIN}/payload.bin`, { proxy: { socks: false, host: "127.0.0.1", port: gatedPort, token: "wrong" } });
equal("a plain-http caller with a wrong token gets 407", wrongFlow.status, 407);
await readAll(wrongFlow);

// https targets use CONNECT, where the same refusal surfaces as a rejected tunnel.
await expectThrow(
	"a CONNECT without the token is refused",
	async () => connectTunnel({ host: "127.0.0.1", port: gatedPort }, "127.0.0.1", 443, 3000),
	/407/
);

// SOCKS5 cannot carry the token in its greeting, so a gated core refuses the protocol.
const socksReply = await new Promise((resolve, reject) => {
	const socket = nodeNet.connect({ host: "127.0.0.1", port: gatedPort });
	const timer = setTimeout(() => {
		socket.destroy();
		reject(new Error("SOCKS5 greeting timed out"));
	}, 3000);
	socket.once("connect", () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
	socket.once("data", (chunk) => {
		clearTimeout(timer);
		socket.destroy();
		resolve(chunk);
	});
	socket.once("error", reject);
});
check("a SOCKS5 caller is refused by a gated core", socksReply.length >= 2 && socksReply[0] === 0x05 && socksReply[1] === 0xff, `got ${[...socksReply].join(",")}`);

check(
	"the ungated core still serves plain callers (used by the tests above)",
	await (async () => {
		const flow = await httpFlow(`${ORIGIN}/payload.bin`, { proxy: CORE });
		await readAll(flow);
		return flow.status === 200;
	})()
);

gated.stop();

// ---------------------------------------------------------------------------
section("shell 代理适配（git / curl）");
const shellProxy = await import("../lib/core/shell-proxy.js");
const shellEngine = new RuleEngine({});

equal("extractHttpUrls finds one", shellProxy.extractHttpUrls("git clone https://github.com/x/y.git").join(","), "https://github.com/x/y.git");
equal("extractHttpUrls dedupes", shellProxy.extractHttpUrls("curl https://a.com/1 https://a.com/1").length, 1);
equal("extractHttpUrls strips trailing punctuation", shellProxy.extractHttpUrls("curl https://a.com/x.").join(","), "https://a.com/x");

const foreignVerdict = shellProxy.classifyShellCommand("git clone https://github.com/x/y.git", shellEngine);
check("a foreign git clone is detected", foreignVerdict.isDownload === true && foreignVerdict.foreign.length === 1, JSON.stringify(foreignVerdict));
check("a foreign curl is detected", shellProxy.classifyShellCommand("curl -O https://objects.githubusercontent.com/a.zip", shellEngine).foreign.length === 1);
check("Invoke-WebRequest is detected", shellProxy.classifyShellCommand("Invoke-WebRequest https://github.com/x", shellEngine).foreign.length === 1);

check("a domestic curl is not flagged", shellProxy.classifyShellCommand("curl https://www.baidu.com/x", shellEngine).foreign.length === 0);
check(
	"an already-proxied command is not flagged",
	(() => {
		const verdict = shellProxy.classifyShellCommand("$env:HTTP_PROXY='x'; curl https://github.com/x", shellEngine);
		return verdict.alreadyProxied === true && verdict.foreign.length === 0;
	})()
);
check("a curl with -x is not flagged", shellProxy.classifyShellCommand("curl -x http://127.0.0.1:7890 https://github.com/x", shellEngine).foreign.length === 0);
check("a loopback curl is not flagged", shellProxy.classifyShellCommand("curl http://127.0.0.1:8080/health", shellEngine).foreign.length === 0);
check("a private-ip curl is not flagged", shellProxy.classifyShellCommand("curl http://192.168.1.5/x", shellEngine).foreign.length === 0);
check("an ssh remote is not flagged (env proxy cannot help it)", shellProxy.classifyShellCommand("git clone git@github.com:x/y.git", shellEngine).foreign.length === 0);
check("a git push is not treated as a download", shellProxy.classifyShellCommand("git push origin main", shellEngine).isDownload === false);
check("an unrelated command is not treated as a download", shellProxy.classifyShellCommand("npm run build", shellEngine).isDownload === false);
check("without an engine nothing is flagged", shellProxy.classifyShellCommand("git clone https://github.com/x/y.git", null).foreign.length === 0);
check("a rejected host is not flagged as foreign", shellProxy.classifyShellCommand("curl https://blocked.example/x", new RuleEngine({ extraRules: ["DOMAIN-SUFFIX,blocked.example,REJECT"] })).foreign.length === 0);

const pwshPrefix = shellProxy.buildShellPrefix({ shell: "pwsh", proxyUrl: "http://dsh:t@127.0.0.1:9", noProxy: "localhost,deepseek.com" });
check("the pwsh prefix assigns $env vars", pwshPrefix.includes("$env:HTTP_PROXY='http://dsh:t@127.0.0.1:9';"), pwshPrefix);
check("the pwsh prefix also sets lowercase names", pwshPrefix.includes("$env:https_proxy=") && pwshPrefix.includes("$env:no_proxy='localhost,deepseek.com';"));
const bashPrefix = shellProxy.buildShellPrefix({ shell: "bash", proxyUrl: "p", noProxy: "n" });
check("the bash prefix uses export", bashPrefix.includes("export HTTP_PROXY='p';"), bashPrefix);
equal("buildProxyUrl carries the token", shellProxy.buildProxyUrl({ port: 1234, token: "abc" }), "http://dsh:abc@127.0.0.1:1234");
check("the explanation names the foreign host", shellProxy.explainShellRouting({ foreign: [{ url: "u", host: "github.com" }] }).includes("github.com"));

// 回归：shell 工具的 description 是必填的，漏了它会被直接拒绝（实测踩过）。
const delegatedArgs = shellProxy.buildShellToolArguments({ command: "$env:HTTP_PROXY='p'; git clone u" });
check("the delegated arguments always carry a description", typeof delegatedArgs.description === "string" && delegatedArgs.description.length > 0, JSON.stringify(delegatedArgs));
check("the generated description names the command", delegatedArgs.description.includes("git clone u"), delegatedArgs.description);
equal("a caller description wins", shellProxy.buildShellToolArguments({ command: "x", description: "  拉取仓库  " }).description, "拉取仓库");
check("workdir is omitted when absent", !("workdir" in shellProxy.buildShellToolArguments({ command: "x" })));
check("workdir is passed through when present", shellProxy.buildShellToolArguments({ command: "x", workdir: "H:\\mycode" }).workdir === "H:\\mycode");

const proxiedReport = asText(__internals.renderProxiedRun({
	executed: true, shell: "pwsh", command: "x", no_proxy: "n", output: "Cloning into 'y'...", exit_note: null
}));
check("the proxied-run report has no undefined", !proxiedReport.includes("undefined"), proxiedReport);
check("the proxied-run report shows the output", proxiedReport.includes("Cloning into"), proxiedReport);

const proxiedDryRun = asText(__internals.renderProxiedRun({
	executed: false, shell: "pwsh", command: "$env:HTTP_PROXY='p'; git clone u", no_proxy: "n", output: null, exit_note: "原样交给 shell 工具执行即可。"
}));
check("the dry-run report shows the command", proxiedDryRun.includes("git clone u"), proxiedDryRun);
check("the dry-run report has no undefined", !proxiedDryRun.includes("undefined"), proxiedDryRun);

// ---------------------------------------------------------------------------
section("下载鉴权（headers / auth）");
const authMod = await import("../lib/download/auth.js");

equal("sanitizeHeaders drops Host", Object.keys(authMod.sanitizeHeaders({ Host: "x", "X-A": "1" })).join(","), "X-A");
check("sanitizeHeaders drops Content-Length", authMod.sanitizeHeaders({ "Content-Length": "5" })["Content-Length"] === undefined);
check("sanitizeHeaders drops Proxy-Authorization", authMod.sanitizeHeaders({ "Proxy-Authorization": "x" })["Proxy-Authorization"] === undefined);
check("sanitizeHeaders tolerates null and junk", Object.keys(authMod.sanitizeHeaders(null)).length === 0 && Object.keys(authMod.sanitizeHeaders("nope")).length === 0);
equal("sanitizeHeaders stringifies numbers", authMod.sanitizeHeaders({ "X-N": 5 })["X-N"], "5");

check("hasSensitiveHeaders spots Authorization", authMod.hasSensitiveHeaders({ authorization: "x" }) === true);
check("hasSensitiveHeaders spots Cookie", authMod.hasSensitiveHeaders({ Cookie: "x" }) === true);
check("hasSensitiveHeaders ignores ordinary headers", authMod.hasSensitiveHeaders({ "X-A": "1" }) === false);
check("stripSensitiveHeaders removes them", Object.keys(authMod.stripSensitiveHeaders({ Cookie: "a", Authorization: "b", "X-A": "1" })).join(","), "X-A");

const noAuth = await authMod.resolveAuth(undefined);
check("no auth yields no headers", Object.keys(noAuth.headers).length === 0 && noAuth.source === null);
process.env.DSH_TEST_TOKEN = "abc123";
const viaEnv = await authMod.resolveAuth("env:DSH_TEST_TOKEN");
equal("env: becomes a Bearer header", viaEnv.headers.Authorization, "Bearer abc123");
await expectThrow("env: with a missing variable fails", async () => authMod.resolveAuth("env:DSH_NOT_SET_ANYWHERE"), /没有值/);
await expectThrow("env: without a name fails", async () => authMod.resolveAuth("env:"), /变量名/);
const literalAuth = await authMod.resolveAuth("bearer:xyz");
equal("bearer: becomes a header", literalAuth.headers.Authorization, "Bearer xyz");
check("bearer: carries a warning about the session log", typeof literalAuth.warning === "string" && literalAuth.warning.includes("会话记录"));
await expectThrow("an unknown auth reference is rejected", async () => authMod.resolveAuth("token:xyz"), /无法识别的 auth/);
delete process.env.DSH_TEST_TOKEN;

// 端到端：夹具的 /needs-auth 要求 `Bearer test-token`。
const authTarget = path.join(tmpRoot, "auth", "ok.bin");
const authed = await attemptDownload({
	url: `${ORIGIN}/needs-auth`,
	savePath: authTarget,
	headers: { Authorization: "Bearer test-token" },
	maxBytes: 64 * 1024 * 1024
});
equal("an authenticated download succeeds", authed.sha256, BIG_SHA);
await expectThrow(
	"without the header it is 401",
	async () => attemptDownload({ url: `${ORIGIN}/needs-auth`, savePath: path.join(tmpRoot, "auth", "no.bin"), maxBytes: 64 * 1024 * 1024 }),
	/401/
);

// 分片请求也必须带上凭据头，否则每一条 Range 都会被拒。
const authThreaded = await attemptDownload({
	url: `${ORIGIN}/needs-auth`,
	savePath: path.join(tmpRoot, "auth", "threaded.bin"),
	headers: { Authorization: "Bearer test-token" },
	threads: 4,
	maxBytes: 64 * 1024 * 1024
});
check("the segmented path keeps the auth header", authThreaded.sha256 === BIG_SHA && authThreaded.viaThreads === true, JSON.stringify({ sha: authThreaded.sha256 === BIG_SHA, threads: authThreaded.viaThreads }));

// 重定向：同域保留凭据头，跨域必须丢掉（别把 token 交给第三方主机）。
const sameHop = await httpFlow(`${ORIGIN}/auth-same-redirect`, { headers: { Authorization: "Bearer keepme" } });
equal("a same-host redirect keeps the token", (await readAll(sameHop)).toString("utf8").trim(), "auth=Bearer keepme keep=none");
const crossHop = await httpFlow(`${ORIGIN}/auth-cross-redirect`, { headers: { Authorization: "Bearer keepme", "X-Keep": "yes" } });
const crossBody = (await readAll(crossHop)).toString("utf8").trim();
check("a cross-host redirect drops the token", crossBody.startsWith("auth=none"), crossBody);
check("a cross-host redirect keeps ordinary headers", crossBody.includes("keep=yes"), crossBody);

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
authProbe.closeAllConnections?.();
await new Promise((resolve) => server.close(() => resolve()));
await new Promise((resolve) => authProbe.close(() => resolve()));
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
