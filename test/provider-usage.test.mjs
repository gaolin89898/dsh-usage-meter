import { test } from "node:test";
import assert from "node:assert/strict";
import { createProviderUsage, normalizeMagpie, normalizeMiniMax } from "../lib/provider-usage.js";
import { callRoute, credentials, jsonResponse, loadHost, makeCtx, usagePayload } from "./support/harness.mjs";

const host = await loadHost();
const miniPayload = { model_remains: [{ model_name: "MiniMax-M2.5", current_interval_remaining_percent: 75, current_weekly_remaining_percent: 90, end_time: 1800000000000 }] };
const overviewPayload = {
	accounts: [{ nickname: "one", credits: 2540, credits_total: 6300, realm: "cn" }, { nickname: "two", credits: 2064, credits_total: 4100, realm: "global" }],
	doubao_accounts: [{ credits: 4004, credits_total: 4100, plan: "标准套餐" }],
	minimax_accounts: [{ credits: 4424 }],
	trae_accounts: [], qoder_accounts: [], loomy_accounts: [], antigravity_accounts: []
};
const magpiePayload = {
	data: [
		{ provider: "volcengine", name: "Volcengine Ark", windows: [{ name: "5 hours", used: 12.5, remaining: 87.5, display: "39.72 / 10,000", resetsAt: "2026-11-18T13:00:08+08:00" }] },
		{ provider: "deepseek", name: "DeepSeek", windows: [], balance: "¥45.78" },
		{ provider: "workbuddy", name: "WorkBuddy", windows: [{ name: "Reward", used: 0, remaining: 100, balance: 200, display: "剩 200 额度" }, { name: "Credits", used: 100, remaining: 0, display: "500 / 500", resetsAt: "2026-11-30T15:59:59Z" }] },
		{ provider: "trae-cn", name: "Trae CN", user: "林九序", last: true, windows: [{ name: "Credits", used: 77.65, remaining: 22.35, display: "648.29 / 2,900", resetsAt: "2026-11-30T15:59:59Z" }] },
		{ provider: "trae-cn", name: "Trae CN", user: "林九序二号", windows: [{ name: "Credits", used: 0, remaining: 100, display: "0 / 2,300", resetsAt: "2026-11-30T15:59:59Z" }] }
	]
};
const magpieUsagePayload = {
	rows: [
		{ t: "2026-11-18T04:00:00Z", provider: "workbuddy", providerAccount: "林九序", session: "session-other" },
		{ t: "2026-11-18T03:00:00Z", provider: "trae-cn", providerAccount: "林九序二号", session: "session-live" },
		{ t: "2026-11-18T02:00:00Z", provider: "trae-cn", providerAccount: "林九序", session: "session-live" }
	]
};

function boot() {
	const providers = {
		"opencode-go": { apiKeyEnv: "GO", baseURL: "https://opencode.ai/zen/go" },
		"minimax-cn": { apiKeyEnv: "MINI", displayName: "MiniMax" },
		deepseek: { apiKeyEnv: "DEEP" },
		openrouter: { apiKeyEnv: "ROUTER" },
		"moonshot-cn": { apiKeyEnv: "MOON" },
		"ai-toolbox": { apiKeyEnv: "AI_TOOLBOX_API_KEY", baseURL: "http://127.0.0.1:7863/v1" },
		magpie: { apiKeyEnv: "MAGPIE_GATEWAY_KEY", baseURL: "http://127.0.0.1:3425/v1" },
		"remote-http": { apiKeyEnv: "CUSTOM", baseURL: "http://example.com/v1" },
		custom: { apiKeyEnv: "CUSTOM", baseURL: "https://example.com/v1" }
	};
	const map = { GO: "go-test", MINI: "mini-test", DEEP: "deep-test", ROUTER: "router-test", MOON: "moon-test", AI_TOOLBOX_API_KEY: "toolbox-test", MAGPIE_GATEWAY_KEY: "magpie-test", CUSTOM: "custom-test" };
	const requests = [];
	let fail = false;
	globalThis.fetch = async (url, options) => {
		if (String(url).includes("registry.npmjs.org")) return jsonResponse({ version: "0.0.1" });
		requests.push({ url, auth: new Headers(options.headers).get("authorization") });
		if (fail) return jsonResponse({ error: "private upstream message" }, 401);
		if (String(url).includes("coding_plan/remains")) return jsonResponse(miniPayload);
		if (String(url).includes("/v1/magpie/quotas")) return jsonResponse(magpiePayload);
		if (String(url).includes("/v1/magpie/usage/requests")) return jsonResponse(magpieUsagePayload);
		if (String(url).includes("/panel/api/overview")) return jsonResponse(overviewPayload);
		if (String(url).includes("opencode.ai")) return jsonResponse(usagePayload());
		if (String(url).includes("deepseek.com")) return jsonResponse({ balance_infos: [{ total_balance: "12.3456", currency: "CNY" }, { total_balance: "0", currency: "USD" }] });
		if (String(url).includes("openrouter.ai")) return jsonResponse({ data: { total_credits: 10, total_usage: 3.5 } });
		if (String(url).includes("moonshot.cn")) return jsonResponse({ data: { available_balance: "0" } });
		throw new Error("Unexpected URL");
	};
	const entry = { options: { id: "llm-pi-ai" }, fiber: { uid: 1, config: { providers: { get: () => providers } } } };
	const harness = makeCtx({ entries: [entry], credentialMap: map });
	const config = { injectSessionHeader: false, updateCheck: false, cacheMs: 30000 };
	host.apply(harness.ctx, config);
	return {
		...harness, providers, map, requests, config,
		fail: (value) => { fail = value; },
		usage: (provider, model = "MiniMax-M2.5", session) => callRoute(harness.routes, "/opencode-go/usage", {
			url: "/opencode-go/usage?" + new URLSearchParams({ provider, model, ...(session === undefined ? {} : { session }) })
		})
	};
}

test("provider route switches GO, MiniMax and monetary balances with matching credentials", async () => {
	const app = boot();
	assert.equal((await app.usage("opencode-go")).body.usage.monthly.percent, 56);
	const mini = await app.usage("minimax-cn");
	assert.equal(mini.body.provider.id, "minimax-cn");
	assert.equal(mini.body.usage.rolling.percent, 25);
	assert.equal(mini.body.usage.weekly.percent, 10);
	assert.equal(mini.body.usage.monthly, undefined);
	assert.deepEqual((await app.usage("deepseek")).body.balances, [{ amount: 12.3456, currency: "CNY" }, { amount: 0, currency: "USD" }]);
	assert.equal((await app.usage("openrouter")).body.balances[0].amount, 6.5);
	assert.equal((await app.usage("moonshot-cn")).body.balances[0].amount, 0);
	assert.deepEqual(app.requests.map((request) => request.auth), ["Bearer go-test", "Bearer mini-test", "Bearer deep-test", "Bearer router-test", "Bearer moon-test"]);
	assert.ok(!JSON.stringify(mini.body).includes("mini-test"));
});

test("unsupported routes, custom proxies and missing credentials never fall back to GO", async () => {
	const app = boot();
	for (const id of ["custom", "remote-http", "unknown", "__proto__"]) {
		const response = await app.usage(id);
		assert.equal(response.status, 200);
		assert.equal(response.body.kind, "unavailable");
		assert.equal(response.body.reason, "unsupported");
		assert.equal(response.body.usage, undefined);
	}
	delete app.map.MINI;
	assert.equal((await app.usage("minimax-cn")).body.reason, "missing-credential");
	assert.equal(app.requests.length, 0);
});

test("AI Toolbox returns remaining credits without percentage conversion", async () => {
	const app = boot();
	const workbuddy = await app.usage("ai-toolbox", "cn:glm-5.3");
	assert.equal(workbuddy.body.provider.name, "AI 工具箱网关");
	assert.equal(workbuddy.body.kind, "credits");
	assert.deepEqual(workbuddy.body.credits, { remaining: 4604, total: 10400 });
	assert.equal(workbuddy.body.usage, undefined);
	const doubao = await app.usage("ai-toolbox", "doubao/doubao");
	assert.deepEqual(doubao.body.credits, { remaining: 4004, total: 4100 });
	assert.equal(doubao.body.usage, undefined);
	const unsupported = await app.usage("ai-toolbox", "antigravity/model");
	assert.equal(unsupported.body.kind, "unavailable");
	assert.equal(unsupported.body.reason, "model-unsupported");
	delete app.map.AI_TOOLBOX_API_KEY;
	assert.equal((await app.usage("ai-toolbox", "loomy/model")).body.reason, "missing-credential");
	assert.equal(app.requests.length, 3);
	assert.ok(app.requests.every((request) => request.url === "http://127.0.0.1:7863/panel/api/overview" && request.auth === "Bearer toolbox-test"));
	assert.ok(!workbuddy.raw.includes("toolbox-test"));
});

test("Magpie follows the gateway scope and filters a provider route", async () => {
	const app = boot();
	const gateway = await app.usage("magpie", "group/smart-split");
	assert.equal(gateway.body.kind, "magpie");
	assert.equal(gateway.body.scope, "gateway");
	assert.equal(gateway.body.current.name, "Trae CN · 林九序");
	assert.equal(gateway.body.current.windows[0].percent, 22.35);
	assert.equal(gateway.body.accounts, undefined);
	const provider = await app.usage("magpie", "volcengine/ark-code-latest");
	assert.equal(provider.body.scope, "provider");
	assert.equal(provider.body.current.name, "Volcengine Ark");
	assert.equal(provider.body.current.windows[0].percent, 87.5);
	const unsupported = await app.usage("magpie", "unknown/model");
	assert.equal(unsupported.body.reason, "model-unsupported");
	assert.deepEqual(app.requests.map((request) => request.auth), ["Bearer magpie-test", "Bearer magpie-test", "Bearer magpie-test"]);
	assert.ok(app.requests.every((request) => request.url === "http://127.0.0.1:3425/v1/magpie/quotas"));
	assert.ok(!JSON.stringify(gateway.body).includes("magpie-test"));
});

test("Magpie keeps text and balance windows out of percentage meters", () => {
	const result = normalizeMagpie(magpiePayload, "workbuddy/model");
	assert.equal(result.current.windows[0].percent, null);
	assert.equal(result.current.windows[0].detail, "剩 200 额度");
	assert.equal(result.current.windows[1].percent, 0);
	const latest = normalizeMagpie({ data: [
		{ provider: "one", name: "One", lastServedAt: "2026-11-18T01:00:00Z" },
		{ provider: "two", name: "Two", lastServedAt: "2026-11-18T02:00:00Z" }
	] }, "group/smart-split");
	assert.equal(latest.current.name, "Two");
	const filtered = normalizeMagpie({ data: [
		{ provider: "one", name: "One" },
		{ provider: "two", name: "Two", last: true }
	] }, "one/model");
	assert.equal(filtered.current.name, "One");
	const served = normalizeMagpie(magpiePayload, "group/smart-split", { provider: "trae-cn", account: "林九序二号" });
	assert.equal(served.current.name, "Trae CN · 林九序二号");
	const aliased = normalizeMagpie({ data: [
		{ provider: "qoder-cn", name: "Qoder CN", alias: "191****1347" }
	] }, "group/smart-split", { provider: "qoder-cn", account: "191****1347" });
	assert.equal(aliased.current.id, "qoder-cn:191****1347");
	assert.equal(normalizeMagpie({ data: [] }, "group/smart-split").reason, "model-unsupported");
	assert.throws(() => normalizeMagpie({ data: [{ name: "missing provider" }] }, "group/smart-split"), /Invalid Magpie/);
});

test("Magpie reports remaining credits instead of used amounts", () => {
	const result = normalizeMagpie({ data: [{ provider: "workbuddy", name: "WorkBuddy", windows: [
		{ name: "Credits", used: 100, amount: 500, limit: 500, display: "500 / 500" },
		{ name: "Extra credits", used: 45.34, amount: 2077.59, limit: 4582, display: "2077.59 / 4582" },
		{ name: "Total credits", used: 50.72, amount: 2577.59, limit: 5082, display: "2577.59 / 5082" }
	] }] }, "workbuddy/model");
	assert.deepEqual(result.current.windows.map((win) => win.percent), [0, 54.66, 49.28]);
	assert.deepEqual(result.current.windows.map((win) => win.detail), ["0 / 500", "2,504.41 / 4,582", "2,504.41 / 5,082"]);
});

test("Magpie hides token-usage estimate windows", () => {
	const result = normalizeMagpie({ data: [{ provider: "workbuddy", name: "WorkBuddy", windows: [
		{ name: "Credits", used: 100, remaining: 0, display: "500 / 500" },
		{ name: "deepseek-v4.1-flash tokens (est.)", used: 9.52, remaining: 90.48, display: "19.0M / ~200M" }
	] }] }, "workbuddy/model");
	assert.deepEqual(result.current.windows.map((win) => win.label), ["Credits"]);
});

test("Magpie shows the account that served the session instead of the gateway's last flag", async () => {
	const app = boot();
	const served = await app.usage("magpie", "group/smart-split", "session-live");
	assert.equal(served.body.current.name, "Trae CN · 林九序二号");
	assert.equal(served.body.current.id, "trae-cn:林九序二号");
	assert.ok(app.requests.some((request) => request.url === "http://127.0.0.1:3425/v1/magpie/usage/requests?session=session-live"));
	const unknown = await app.usage("magpie", "group/smart-split", "session-gone");
	assert.equal(unknown.body.current.name, "Trae CN · 林九序");
	const invalid = await app.usage("magpie", "group/smart-split", "not a session");
	assert.equal(invalid.status, 400);
	assert.equal(invalid.body.error, "Invalid session");
});

test("provider cache coalesces reads and isolates models, providers and credential changes", async () => {
	const app = boot();
	await Promise.all([app.usage("minimax-cn"), app.usage("minimax-cn")]);
	assert.equal(app.requests.length, 1);
	await app.usage("deepseek");
	await app.usage("minimax-cn", "MiniMax-M2.7");
	assert.equal(app.requests.length, 3);
	app.map.MINI = "rotated-mini-test";
	await app.usage("minimax-cn");
	assert.equal(app.requests.length, 4);
	assert.equal(app.requests[3].auth, "Bearer rotated-mini-test");
});

test("a provider error is retried and cannot expose the upstream body or previous quota", async () => {
	const app = boot();
	await app.usage("opencode-go");
	app.fail(true);
	const response = await app.usage("minimax-cn");
	assert.equal(response.status, 502);
	assert.equal(response.body.requested, "minimax-cn");
	assert.equal(response.body.usage, undefined);
	assert.match(response.body.error, /401/);
	assert.ok(!response.raw.includes("private upstream"));
	app.fail(false);
	assert.equal((await app.usage("minimax-cn")).body.kind, "quota");
});

test("MiniMax matches the current model rather than taking the first quota row", () => {
	const row = miniPayload.model_remains[0];
	const result = normalizeMiniMax({ model_remains: [{ ...row, model_name: "other", current_interval_remaining_percent: 1 }, row] }, "minimax-m2.5");
	assert.equal(result.usage.rolling.percent, 25);
	assert.equal(result.usage.rolling.resetsAt, new Date(row.end_time).toISOString());
	assert.equal(result.usage.weekly.resetsAt, null);
	assert.equal(normalizeMiniMax({ model_remains: [row, { ...row, model_name: "other" }] }, "unknown").reason, "model-unsupported");
	for (const value of [null, "", -1, 101]) {
		assert.throws(() => normalizeMiniMax({ model_remains: [{ model_name: "test", current_interval_remaining_percent: value }] }, "test"));
	}
	assert.equal(normalizeMiniMax({ ...miniPayload, base_resp: { status_code: "0" } }, "MiniMax-M2.5").kind, "quota");
	assert.throws(() => normalizeMiniMax({ base_resp: { status_code: 1004 } }, "test"), /1004/);
});

test("DeepSeek account uses the native account service and preserves wallet currencies", async () => {
	const harness = makeCtx({ services: { deepseekAccount: {
		async getBalance(client) {
			assert.equal(client.locale, "zh");
			return { status: "ready", value: [{ currency: "CNY", balance: "1.25" }], bonusWallets: [{ currency: "CNY", balance: "2.5" }, { currency: "USD", balance: "4" }] };
		}
	} } });
	const read = createProviderUsage(harness.ctx, { providers: () => ({}), accountClient: () => ({ version: "", locale: "zh", timezoneOffsetSeconds: 28800 }) });
	assert.deepEqual((await read("deepseek-account", "deepseek")).balances, [{ currency: "CNY", amount: 3.75 }, { currency: "USD", amount: 4 }]);
	harness.services.deepseekAccount.getBalance = async () => null;
	assert.equal((await read("deepseek-account", "deepseek")).reason, "sign-in-required");
});

test("provider request rejects an empty provider", async () => {
	const app = boot();
	assert.equal((await app.usage("")).status, 400);
	assert.equal(app.requests.length, 0);
});
