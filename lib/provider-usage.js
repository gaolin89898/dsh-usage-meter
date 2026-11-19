import { createHash } from "node:crypto";

const DEFAULTS = {
	"opencode-go": { name: "OpenCode GO", baseURL: "https://opencode.ai/zen/go" },
	"minimax-cn": { name: "MiniMax", baseURL: "https://api.minimaxi.com/anthropic" },
	minimax: { name: "MiniMax", baseURL: "https://api.minimax.io/anthropic" },
	deepseek: { name: "DeepSeek", baseURL: "https://api.deepseek.com" },
	"deepseek-official": { name: "DeepSeek", baseURL: "https://api.deepseek.com" },
	openrouter: { name: "OpenRouter", baseURL: "https://openrouter.ai/api/v1" },
	moonshot: { name: "Moonshot", baseURL: "https://api.moonshot.ai/v1" },
	"moonshot-cn": { name: "Moonshot", baseURL: "https://api.moonshot.cn/v1" },
	magpie: { name: "Magpie", baseURL: "http://127.0.0.1:3425/v1" },
	"ai-toolbox": { name: "AI 工具箱网关", baseURL: "http://127.0.0.1:7863/v1" }
};

function number(value) {
	if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return null;
	const result = Number(value);
	return Number.isFinite(result) ? result : null;
}

function balance(amount, currency) {
	const value = number(amount);
	if (value === null || !/^[A-Z]{3}$/.test(currency ?? "")) throw new Error("Invalid balance response");
	return { amount: value, currency };
}

function resetTime(value) {
	if (value == null || value === "") return null;
	const numeric = number(value);
	const time = new Date(numeric === null ? String(value) : numeric);
	return Number.isFinite(time.getTime()) ? time.toISOString() : null;
}

export function pickAccounts(payload, model) {
	const m = String(model ?? "");
	if (m.startsWith("doubao/")) return payload.doubao_accounts ?? [];
	if (m.startsWith("loomy/")) return payload.loomy_accounts ?? [];
	if (m.startsWith("minimax/")) return payload.minimax_accounts ?? [];
	if (m.startsWith("qoder/")) return payload.qoder_accounts ?? [];
	if (m.startsWith("trae/")) return payload.trae_accounts ?? [];
	if (m.startsWith("antigravity/")) return [];
	return (payload.accounts ?? []).filter((account) => (Number(account.credits_total) || 0) > 0);
}

export function normalizeMiniMax(payload, model) {
	const code = number(payload?.base_resp?.status_code);
	if (code !== null && code !== 0) throw new Error(`MiniMax quota request failed (${code})`);
	const rows = payload?.model_remains;
	if (!Array.isArray(rows) || rows.length === 0) throw new Error("Invalid MiniMax quota response");
	const target = String(model ?? "").toLowerCase();
	const row = rows.find((item) => String(item.model_name ?? item.model ?? "").toLowerCase() === target)
		?? (rows.length === 1 ? rows[0] : null);
	if (!row) return { kind: "unavailable", reason: "model-unsupported" };
	const usage = {};
	for (const [key, field, reset] of [
		["rolling", "current_interval_remaining_percent", row.end_time],
		["weekly", "current_weekly_remaining_percent", row.weekly_end_time]
	]) {
		const remaining = number(row[field]);
		if (remaining === null) continue;
		if (remaining < 0 || remaining > 100) throw new Error("Invalid MiniMax remaining percentage");
		usage[key] = { percent: Math.round((100 - remaining) * 100) / 100, status: "ok", resetsAt: resetTime(reset) };
	}
	if (Object.keys(usage).length === 0) throw new Error("Invalid MiniMax quota response");
	return { kind: "quota", usage };
}

/**
 * @param {unknown} payload - `/v1/magpie/quotas` response body.
 * @param {string} model - the model the widget is showing.
 * @param {{ provider: string, account?: string }} [served] - the account that
 *   actually served the current session. The gateway's `last` flag tracks its
 *   own traffic, so a routing group can point at an account nobody uses.
 */
export function normalizeMagpie(payload, model, served) {
	if (!Array.isArray(payload?.data) || payload.data.some((row) => !row || typeof row.provider !== "string" || !row.provider)) {
		throw new Error("Invalid Magpie quota response");
	}
	const prefix = String(model ?? "").split("/")[0];
	const scope = !prefix || prefix === "group" ? "gateway" : "provider";
	const rows = payload.data.filter((row) => scope === "gateway" || row.provider === prefix);
	if (!rows.length) return { kind: "unavailable", reason: "model-unsupported" };
	const text = (value) => typeof value === "string" ? value.trim().slice(0, 200) : "";
	const short = (value) => {
		const label = text(value);
		return label.length > 24 ? label.slice(0, 24) + "…" : label;
	};
	const servedAt = (row) => {
		const value = Date.parse(row.lastServedAt ?? "");
		return Number.isFinite(value) ? value : -Infinity;
	};
	const matchesAccount = (item, account) => {
		const value = text(account);
		return value !== "" && (text(item.user) === value || text(item.alias) === value);
	};
	const servedRow = typeof served?.provider === "string" && served.provider !== ""
		? rows.find((item) => item.provider === served.provider && matchesAccount(item, served.account))
		: undefined;
	const row = servedRow
		?? rows.find((item) => item.last === true)
		?? rows.reduce((latest, item) => servedAt(item) > servedAt(latest) ? item : latest, rows[0]);
	const failed = Boolean(row.error);
	const name = text(row.name) || row.provider;
	const account = rows.filter((item) => item.provider === row.provider).length > 1 ? short(row.alias) || short(row.user) : "";
	// Token-usage estimates (e.g. "deepseek-v4.1-flash tokens (est.)") are not
	// quota windows; showing them only adds noise to the credit meters.
	const tokenEstimate = /\btokens?\s*\(est\.?\)\s*$/i;
	const windows = failed || !Array.isArray(row.windows) ? [] : row.windows.filter((item) => item && text(item.name) && !tokenEstimate.test(text(item.name))).map((item) => {
		const used = number(item.used);
		const remaining = number(item.remaining);
		const percent = item.text || number(item.balance) !== null ? null : used ?? (remaining === null ? null : 100 - remaining);
		return {
			label: text(item.name),
			percent: percent !== null && percent >= 0 ? Math.round(percent * 100) / 100 : null,
			detail: text(item.display),
			resetsAt: resetTime(item.resetsAt)
		};
	}).filter((item) => item.percent !== null || item.detail);
	return {
		kind: "magpie", scope,
		current: {
			id: `${row.provider}:${text(row.user) || text(row.alias) || "current"}`,
			name: account ? `${name} · ${account}` : name,
			balance: failed ? "" : text(row.balance), windows, failed
		}
	};
}

/** Resolve only configured routes; API keys never leave the Host. */
export function createProviderUsage(ctx, options) {
	const cache = new Map();
	const unavailable = (provider, reason) => ({ provider, kind: "unavailable", reason });
	const request = async (url, key) => {
		const response = await fetch(url, {
			headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000), redirect: "error"
		});
		if (!response.ok) throw new Error(`Balance service HTTP ${response.status}`);
		return response.json();
	};
	/**
	 * The account that really served a session.
	 *
	 * `/v1/magpie/usage/requests` keeps the last 100 requests of the whole
	 * gateway and ignores a `session` query, so the rows are matched here.
	 * @param {string} origin
	 * @param {string} key
	 * @param {string} session
	 * @returns {Promise<{ provider: string, account: string } | null>}
	 */
	const magpieServed = async (origin, key, session) => {
		try {
			const payload = await request(`${origin}/v1/magpie/usage/requests?session=${encodeURIComponent(session)}`, key);
			let latest = null;
			for (const row of Array.isArray(payload?.rows) ? payload.rows : []) {
				if (!row || typeof row.provider !== "string" || row.provider === "") continue;
				if (row.session !== session && row.native_session !== session) continue;
				const at = Date.parse(row.t ?? "");
				if (latest === null || (Number.isFinite(at) && at > latest.at)) {
					latest = {
						at: Number.isFinite(at) ? at : -Infinity,
						provider: row.provider,
						account: typeof row.providerAccount === "string" ? row.providerAccount : ""
					};
				}
			}
			return latest ? { provider: latest.provider, account: latest.account } : null;
		} catch {
			return null;
		}
	};

	return async (id, model, session) => {
		const providers = options.providers();
		const configured = providers && Object.hasOwn(providers, id) ? providers[id] : undefined;
		const defaults = Object.hasOwn(DEFAULTS, id) ? DEFAULTS[id] : undefined;
		const provider = { id, name: configured?.displayName || defaults?.name || (id === "deepseek-account" ? "DeepSeek" : id) };
		if (id === "deepseek-account") {
			const account = ctx.get?.("deepseekAccount");
			if (typeof account?.getBalance !== "function") return unavailable(provider, "unsupported");
			// The account service owns credential lifetime and invalidation.
			const result = await account.getBalance(options.accountClient());
			if (result === null) return unavailable(provider, "sign-in-required");
			if (result?.status !== "ready") throw new Error("Could not read DeepSeek balance");
			const wallets = [...(result.value ?? []), ...(result.bonusWallets ?? [])];
			const totals = new Map();
			for (const wallet of wallets) {
				const item = balance(wallet.balance, wallet.currency);
				totals.set(item.currency, (totals.get(item.currency) ?? 0) + item.amount);
			}
			if (totals.size === 0) throw new Error("Invalid DeepSeek balance response");
			return { provider, kind: "balance", balances: [...totals].map(([currency, amount]) => ({ currency, amount })) };
		}
		if (!configured && id === "opencode-go") return { ...await options.go(), provider, kind: "quota" };
		const route = configured ?? (id === "deepseek-official" ? options.deepseek() : undefined);
		if (!route) return unavailable(provider, "unsupported");
		let base;
		try { base = new URL(route.baseURL || defaults?.baseURL); } catch { return unavailable(provider, "unsupported"); }
		// A custom proxy's key must never be sent to a different vendor's endpoint.
		const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(base.hostname);
		if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) return unavailable(provider, "unsupported");
		if (!loopback && (base.port || base.username || base.password)) return unavailable(provider, "unsupported");
		const magpie = id === "magpie" || route.apiKeyEnv === "MAGPIE_GATEWAY_KEY";
		const toolbox = id === "ai-toolbox" || route.apiKeyEnv === "AI_TOOLBOX_API_KEY";
		let url, parse;
		if (magpie) {
			url = `${base.origin}${base.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/magpie/quotas`;
			parse = async (payload) => normalizeMagpie(payload, model, session ? await magpieServed(base.origin, key, session) : undefined);
		} else if (toolbox) {
			url = `${base.origin}/panel/api/overview`;
			parse = (payload) => {
				let remaining = 0, total = 0;
				for (const row of pickAccounts(payload, model)) {
					remaining += Number(row.credits) || 0;
					total += Number(row.credits_total) || 0;
				}
				if (!(total > 0)) return { kind: "unavailable", reason: "model-unsupported" };
				return { kind: "credits", credits: { remaining, total } };
			};
		} else if (base.hostname === "opencode.ai" && /^\/zen\/go\/?$/.test(base.pathname)) {
			const linked = await options.goForRoute?.(route);
			if (linked) return { ...linked, provider, kind: "quota" };
			url = "https://opencode.ai/zen/go/v1/usage";
			parse = (payload) => ({ kind: "quota", usage: options.normalizeGo(payload), source: "builtin" });
		} else if (["api.minimaxi.com", "api.minimax.io"].includes(base.hostname)) {
			url = `${base.origin}/v1/api/openplatform/coding_plan/remains`;
			parse = (payload) => normalizeMiniMax(payload, model);
		} else if (base.hostname === "api.deepseek.com") {
			url = "https://api.deepseek.com/user/balance";
			parse = (payload) => {
				if (!Array.isArray(payload?.balance_infos) || !payload.balance_infos.length) throw new Error("Invalid DeepSeek balance response");
				return { kind: "balance", balances: payload.balance_infos.map((row) => balance(row.total_balance, row.currency)) };
			};
		} else if (base.hostname === "openrouter.ai") {
			url = "https://openrouter.ai/api/v1/credits";
			parse = (payload) => {
				const credits = number(payload?.data?.total_credits), used = number(payload?.data?.total_usage);
				if (credits === null || used === null) throw new Error("Invalid OpenRouter balance response");
				return { kind: "balance", balances: [balance(credits - used, "USD")] };
			};
		} else if (["api.moonshot.cn", "api.moonshot.ai"].includes(base.hostname)) {
			url = `${base.origin}/v1/users/me/balance`;
			parse = (payload) => ({ kind: "balance", balances: [balance(payload?.data?.available_balance, base.hostname.endsWith(".cn") ? "CNY" : "USD")] });
		} else return unavailable(provider, "unsupported");
		const ref = route.apiKeyEnv || (id === "deepseek-official" ? "DEEPSEEK_API_KEY" : magpie ? "MAGPIE_GATEWAY_KEY" : toolbox ? "AI_TOOLBOX_API_KEY" : null);
		const key = ref ? (await ctx.credentials.resolve(ref))?.value : null;
		if (!key) return unavailable(provider, "missing-credential");
		const identity = JSON.stringify([id, model, session ?? "", url, createHash("sha256").update(key).digest("hex")]);
		const now = Date.now();
		const hit = cache.get(identity);
		if (hit && now - hit.at < options.cacheMs()) return { ...await hit.promise, provider };
		const promise = request(url, key).then(parse);
		for (const [key, value] of cache) if (now - value.at >= options.cacheMs()) cache.delete(key);
		if (cache.size >= 64) cache.delete(cache.keys().next().value);
		cache.set(identity, { at: now, promise });
		promise.catch(() => { if (cache.get(identity)?.promise === promise) cache.delete(identity); });
		return { ...await promise, provider };
	};
}
