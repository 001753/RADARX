const crypto = require("node:crypto");

const PROVIDERS = {
  dexscreener: {
    base: "https://api.dexscreener.com",
    minGapMs: 230,
  },
  rugcheck: {
    base: "https://api.rugcheck.xyz/v1",
    minGapMs: 700,
  },
  solana: {
    base: "https://api.mainnet-beta.solana.com",
    minGapMs: 250,
  },
};

const lastRequest = new Map();

function hashPayload(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function waitForRateLimit(provider) {
  const config = PROVIDERS[provider];
  const previous = lastRequest.get(provider) || 0;
  const delay = Math.max(0, config.minGapMs - (Date.now() - previous));
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  lastRequest.set(provider, Date.now());
}

async function fetchJson(provider, endpoint, options = {}) {
  await waitForRateLimit(provider);
  const url = `${PROVIDERS[provider].base}${endpoint}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 8000);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "radar-solana/1.2" },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text.slice(0, 500) }; }
    return {
      provider,
      endpoint,
      ok: response.ok,
      status: response.status,
      payload,
      latencyMs: Date.now() - started,
      hash: hashPayload(payload),
      error: response.ok ? null : `HTTP_${response.status}`,
    };
  } catch (error) {
    return {
      provider,
      endpoint,
      ok: false,
      status: 0,
      payload: null,
      latencyMs: Date.now() - started,
      hash: null,
      error: error.name === "AbortError" ? "TIMEOUT" : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchSolanaRpc(method, params = []) {
  await waitForRateLimit("solana");
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(PROVIDERS.solana.base, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": "radar-solana/1.2" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      signal: controller.signal,
    });
    const payload = await response.json();
    return {
      provider: "solana",
      endpoint: method,
      ok: response.ok && !payload.error,
      status: response.status,
      payload,
      latencyMs: Date.now() - started,
      hash: hashPayload(payload),
      error: payload.error?.message || (response.ok ? null : `HTTP_${response.status}`),
    };
  } catch (error) {
    return {
      provider: "solana",
      endpoint: method,
      ok: false,
      status: 0,
      payload: null,
      latencyMs: Date.now() - started,
      hash: null,
      error: error.name === "AbortError" ? "TIMEOUT" : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function mapDexPair(pair) {
  const txns1h = pair?.txns?.h1 || {};
  const priceChange = pair?.priceChange || {};
  const volume = pair?.volume || {};
  return {
    tokenAddress: pair?.baseToken?.address || null,
    pairAddress: pair?.pairAddress || null,
    name: pair?.baseToken?.name || "Unknown token",
    symbol: pair?.baseToken?.symbol || "—",
    dexId: pair?.dexId || "unknown",
    poolType: pair?.labels?.join(",") || "unknown",
    quoteSymbol: pair?.quoteToken?.symbol || "—",
    pairCreatedAt: pair?.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString() : null,
    priceUsd: number(pair?.priceUsd),
    liquidityUsd: number(pair?.liquidity?.usd),
    volume5m: number(volume.m5),
    volume1h: number(volume.h1),
    volume6h: number(volume.h6),
    volume24h: number(volume.h24),
    buyTx1h: number(txns1h.buys),
    sellTx1h: number(txns1h.sells),
    priceChange1h: number(priceChange.h1) === null ? null : number(priceChange.h1) / 100,
    raw: pair,
  };
}

async function discoverCandidates(limit = 20) {
  const result = await fetchJson("dexscreener", "/token-profiles/latest/v1");
  const profiles = Array.isArray(result.payload) ? result.payload : (result.payload?.profiles || []);
  const candidates = profiles
    .map((profile) => profile?.tokenAddress || profile?.address)
    .filter(Boolean)
    .slice(0, limit);
  return { result, candidates };
}

async function fetchTokenPairs(address) {
  const result = await fetchJson("dexscreener", `/latest/dex/tokens/${encodeURIComponent(address)}`);
  const pairs = Array.isArray(result.payload?.pairs) ? result.payload.pairs : [];
  return { result, pairs: pairs.filter((pair) => pair?.chainId === "solana").map(mapDexPair) };
}

async function fetchRugReport(address) {
  return fetchJson("rugcheck", `/tokens/${encodeURIComponent(address)}/report`);
}

module.exports = {
  fetchJson,
  fetchSolanaRpc,
  discoverCandidates,
  fetchTokenPairs,
  fetchRugReport,
  mapDexPair,
};