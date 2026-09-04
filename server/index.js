const path = require("node:path");
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const {
  calculateScore,
  MODEL_VERSION,
  computeGini,
} = require("./engine");
const {
  OUTCOME_CONFIG,
  outcomeHorizon,
  precisionReport,
} = require("./evaluator");
const {
  discoverCandidates,
  fetchTokenPairs,
  fetchRugReport,
  fetchSolanaRpc,
} = require("./providers");

const PORT = Number(process.env.PORT || 5000);
const app = express();
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 10 }) : null;
const startedAt = new Date();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

function requireDb(res) {
  if (!pool) {
    res.status(503).json({ error: "DATABASE_URL is not configured", code: "DATABASE_REQUIRED" });
    return false;
  }
  return true;
}

async function query(sql, params = []) {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool.query(sql, params);
}

function ageMinutes(pairCreatedAt) {
  if (!pairCreatedAt) return null;
  return Math.max(0, (Date.now() - new Date(pairCreatedAt).getTime()) / 60000);
}

function mapSecurity(report, rpcResults = []) {
  const payload = report?.payload || {};
  const risks = Array.isArray(payload.risks) ? payload.risks : [];
  const riskLevel = String(payload.riskLevel || payload.score?.level || "").toLowerCase();
  const mint = payload.mintAuthority ?? payload.token?.mintAuthority;
  const freeze = payload.freezeAuthority ?? payload.token?.freezeAuthority;
  const topHolder = Number(payload.topHolders?.[0]?.pct ?? payload.topHolderPercent);
  const supply = rpcResults.find((item) => item.method === "getTokenSupply")?.result?.value;
  const account = rpcResults.find((item) => item.method === "getAccountInfo")?.result?.value?.data?.parsed?.info;
  const largest = rpcResults.find((item) => item.method === "getTokenLargestAccounts")?.result?.value || [];
  const supplyAmount = Number(supply?.amount);
  const rpcTopHolder = supplyAmount > 0 && largest.length ? (Number(largest[0]?.amount) / supplyAmount) * 100 : undefined;
  return {
    mintAuthority: account?.mintAuthority === null || mint === null ? "revoked" : (account?.mintAuthority || mint) ? "active" : undefined,
    freezeAuthority: account?.freezeAuthority === null || freeze === null ? "revoked" : (account?.freezeAuthority || freeze) ? "active" : undefined,
    lpState: payload.markets?.length ? "unverified" : undefined,
    topHolderPercent: Number.isFinite(topHolder) ? topHolder : (Number.isFinite(rpcTopHolder) ? rpcTopHolder : undefined),
    riskCategory: riskLevel.includes("danger") || risks.some((risk) => String(risk.level || risk.type).toLowerCase().includes("danger")) ? "danger" : riskLevel ? "review" : undefined,
  };
}

function sourceDataQuality(results) {
  const available = results.filter(Boolean);
  if (!available.length) return 0;
  const healthy = available.filter((item) => item.ok).length / available.length;
  return Math.max(0, Math.min(1, healthy * 0.7 + (available.length >= 2 ? 0.3 : 0)));
}

async function saveObservation(db, tokenAddress, sourceResult) {
  await db.query(
    `INSERT INTO raw_source_observations
      (token_address, source, endpoint, observed_at, status, payload, payload_hash, error_message)
     VALUES ($1, $2, $3, now(), $4, $5, $6, $7)`,
    [
      tokenAddress,
      sourceResult.provider,
      sourceResult.endpoint,
      sourceResult.ok ? "success" : "error",
      sourceResult.payload,
      sourceResult.hash,
      sourceResult.error,
    ],
  );
}

async function saveScanToken(pair, rugResult, mode = "live") {
  const address = pair.tokenAddress;
  if (!address) return null;
  const age = ageMinutes(pair.pairCreatedAt);
  const [supplyResult, largestResult, accountResult] = await Promise.all([
    fetchSolanaRpc("getTokenSupply", [address]),
    fetchSolanaRpc("getTokenLargestAccounts", [address]),
    fetchSolanaRpc("getAccountInfo", [address, { encoding: "jsonParsed" }]),
  ]);
  const rpcResults = [
    { method: "getTokenSupply", ...supplyResult.payload },
    { method: "getTokenLargestAccounts", ...largestResult.payload },
    { method: "getAccountInfo", ...accountResult.payload },
  ];
  const security = mapSecurity(rugResult, rpcResults);
  const input = {
    ...pair,
    ageMinutes: age,
    security,
    dataQuality: sourceDataQuality([rugResult, supplyResult, largestResult, accountResult]),
    liquiditySlopePct: null,
    marketBaseline1h: null,
    marketLiquidityTrend: null,
    uniqueBuyers1h: null,
    holderGrowth: null,
    holderDistribution: null,
    holderRetention: null,
    dev: {},
    cluster: {},
  };
  const result = calculateScore(input, {
    vlr5m: [], vlr1h: [], bsr: [], accel: [], trendQ: [], relativeMomentum: [],
    holderGrowth: [], holderDistribution: [], holderRetention: [],
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO tokens (token_address, name, symbol, first_seen, lifecycle, last_source, updated_at)
       VALUES ($1, $2, $3, now(), $4, $5, now())
       ON CONFLICT (token_address) DO UPDATE SET name = EXCLUDED.name, symbol = EXCLUDED.symbol, lifecycle = EXCLUDED.lifecycle, last_source = EXCLUDED.last_source, updated_at = now()`,
      [address, pair.name, pair.symbol, result.lifecycle, mode],
    );
    if (pair.pairAddress) {
      await client.query(
        `INSERT INTO pairs (pair_address, token_address, dex_id, pool_type, quote_symbol, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (pair_address) DO UPDATE SET dex_id = EXCLUDED.dex_id, pool_type = EXCLUDED.pool_type, updated_at = now()`,
        [pair.pairAddress, address, pair.dexId, pair.poolType, pair.quoteSymbol, pair.pairCreatedAt],
      );
    }
    if (pair.raw) await saveObservation(client, address, { provider: "dexscreener", endpoint: `/latest/dex/tokens/${address}`, ok: true, payload: pair.raw, hash: null, error: null });
    if (rugResult) await saveObservation(client, address, rugResult);
    for (const rpcResult of [supplyResult, largestResult, accountResult]) await saveObservation(client, address, rpcResult);
    const supplyAmount = Number(supplyResult.payload?.result?.value?.amount);
    const largestAccounts = Array.isArray(largestResult.payload?.result?.value) ? largestResult.payload.result.value : [];
    const topHolderDistribution = supplyAmount > 0
      ? largestAccounts.map((account) => Number(account.amount) / supplyAmount).filter(Number.isFinite)
      : [];
    await client.query(
      `INSERT INTO holder_snapshots (token_address, observed_at, holder_count, distribution, gini, data_quality)
       VALUES ($1, now(), $2, $3, $4, $5)`,
      [
        address,
        null,
        JSON.stringify(topHolderDistribution),
        computeGini(topHolderDistribution),
        JSON.stringify({ source: "solana", coverage: topHolderDistribution.length ? "top_accounts_only" : "unavailable", accountCount: topHolderDistribution.length }),
      ],
    );
    await client.query(
      `INSERT INTO market_snapshots
        (token_address, pair_address, observed_at, price_usd, liquidity_usd, volume_5m, volume_1h, volume_6h, volume_24h, buy_tx_1h, sell_tx_1h, data_quality)
       VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [address, pair.pairAddress, pair.priceUsd, pair.liquidityUsd, pair.volume5m, pair.volume1h, pair.volume6h, pair.volume24h, pair.buyTx1h, pair.sellTx1h, JSON.stringify({ mode, provider: "dexscreener", quality: input.dataQuality })],
    );
    for (const decision of result.gates) {
      await client.query(
        `INSERT INTO gate_decisions
          (token_address, pair_address, observed_at, gate_name, status, reason_code, evidence, threshold_version, model_version)
         VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8)`,
        [address, pair.pairAddress, decision.name, decision.status, decision.reasonCode, JSON.stringify(decision.evidence), decision.version, result.modelVersion],
      );
    }
    await client.query(
      `INSERT INTO score_snapshots
        (token_address, pair_address, observed_at, lifecycle, market_regime, momentum_score, holder_health_score, flow_quality_score, liquidity_quality_score, raw_score, signal_score, evidence_confidence, priority_score, label, score_status, active_weights, penalties, evidence, cohort_size, model_version)
       VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [address, pair.pairAddress, result.lifecycle, result.regime, result.components.momentum, result.components.holderHealth, result.components.flowQuality, result.components.liquidityQuality, result.rawScore, result.signalScore, result.evidenceConfidence, result.priorityScore, result.label, result.scoreStatus, JSON.stringify(result.activeWeights), JSON.stringify(result.penalties), JSON.stringify(result.evidence), 0, result.modelVersion],
    );
    if (["HIGH_PRIORITY", "WATCHLIST"].includes(result.label)) {
      await client.query(
        `INSERT INTO watchlist (token_address, pair_address, last_refresh_at, status, last_final_score, last_label, last_evidence)
         VALUES ($1, $2, now(), 'active', $3, $4, $5)
         ON CONFLICT (token_address) DO UPDATE SET pair_address = EXCLUDED.pair_address, last_refresh_at = now(), status = 'active', last_final_score = EXCLUDED.last_final_score, last_label = EXCLUDED.last_label, last_evidence = EXCLUDED.last_evidence`,
        [address, pair.pairAddress, result.signalScore, result.label, JSON.stringify(result.evidence)],
      );
      await client.query(
        `INSERT INTO alert_events (token_address, pair_address, alert_type, alert_at, dedupe_key, status, evidence)
         SELECT $1, $2, $3, now(), $4, 'paper', $5
         WHERE NOT EXISTS (
           SELECT 1 FROM alert_events
           WHERE token_address = $1 AND alert_type = $3 AND alert_at > now() - interval '6 hours'
         )`,
        [address, pair.pairAddress, result.label, `${address}:${result.label}:${Math.floor(Date.now() / 21600000)}`, JSON.stringify({ ...result.evidence, score: result.signalScore, confidence: result.evidenceConfidence })],
      );
    } else {
      await client.query(`UPDATE watchlist SET status = 'archived', last_refresh_at = now(), last_label = $2 WHERE token_address = $1`, [address, result.label]);
    }
    await client.query("COMMIT");
    return { ...pair, ageMinutes: age, ...result, dataMode: mode.toUpperCase() };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

let scanLock = false;

async function scanLive(mode = "live") {
  if (!pool) throw new Error("DATABASE_URL is required for live scan");
  const started = Date.now();
  const run = await query(`INSERT INTO scan_runs (mode) VALUES ($1) RETURNING id`, [mode]);
  let candidatesSeen = 0;
  let observationsSaved = 0;
  let rejected = 0;
  let unknown = 0;
  let passed = 0;
  let errors = 0;
  const output = [];
  const discovery = await discoverCandidates(18);
  const profiles = discovery.candidates;
  candidatesSeen = profiles.length;
  await query(`INSERT INTO provider_health (provider, status, latency_ms, detail) VALUES ($1, $2, $3, $4)`, ["dexscreener", discovery.result.ok ? "healthy" : "degraded", discovery.result.latencyMs, JSON.stringify({ status: discovery.result.status, error: discovery.result.error })]);
  for (const address of profiles) {
    try {
      const tokenResult = await fetchTokenPairs(address);
      if (!tokenResult.result.ok) {
        errors += 1;
        await query(
          `INSERT INTO tokens (token_address, first_seen, lifecycle, last_source, updated_at)
           VALUES ($1, now(), 'NEW', 'dexscreener', now())
           ON CONFLICT (token_address) DO NOTHING`,
          [address],
        );
        await saveObservation(pool, address, tokenResult.result);
        continue;
      }
      const pairs = tokenResult.pairs.sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0)).slice(0, 1);
      if (!pairs.length) continue;
      const rug = await fetchRugReport(address);
      await query(`INSERT INTO provider_health (provider, status, latency_ms, detail) VALUES ($1, $2, $3, $4)`, ["rugcheck", rug.ok ? "healthy" : "degraded", rug.latencyMs, JSON.stringify({ status: rug.status, error: rug.error })]);
      const scored = await saveScanToken(pairs[0], rug);
      output.push(scored);
      observationsSaved += 1;
      if (scored.label === "REJECTED") rejected += 1;
      else if (["QUARANTINED", "NO_CALL"].includes(scored.label)) unknown += 1;
      else passed += 1;
    } catch (error) {
      errors += 1;
      console.error(`scan ${address}:`, error.message);
    }
  }
  await query(
    `UPDATE scan_runs SET finished_at = now(), candidates_seen = $1, observations_saved = $2, passed = $3, rejected = $4, unknown = $5, errors = $6, summary = $7 WHERE id = $8`,
    [candidatesSeen, observationsSaved, passed, rejected, unknown, errors, JSON.stringify({ durationMs: Date.now() - started }), run.rows[0].id],
  );
  const outcomes = await labelDueOutcomes();
  return { runId: run.rows[0].id, candidatesSeen, observationsSaved, passed, rejected, unknown, errors, durationMs: Date.now() - started, outcomes, output };
}

async function refreshWatchlist() {
  if (!pool) return { skipped: true, reason: "database_required" };
  const list = await query(`SELECT token_address AS "tokenAddress", pair_address AS "pairAddress" FROM watchlist WHERE status = 'active' ORDER BY last_refresh_at ASC LIMIT 50`);
  let refreshed = 0;
  for (const item of list.rows) {
    try {
      const tokenResult = await fetchTokenPairs(item.tokenAddress);
      const pair = tokenResult.pairs.find((candidate) => candidate.pairAddress === item.pairAddress) || tokenResult.pairs[0];
      if (!pair) continue;
      const rug = await fetchRugReport(item.tokenAddress);
      await saveScanToken(pair, rug, "watchlist");
      refreshed += 1;
    } catch (error) {
      console.error(`watchlist ${item.tokenAddress}:`, error.message);
    }
  }
  return { refreshed };
}

async function labelDueOutcomes() {
  if (!pool) return { labeled: 0 };
  const alerts = await query(
    `SELECT a.id, a.token_address AS "tokenAddress", a.pair_address AS "pairAddress", a.alert_type AS "alertType",
            a.alert_at AS "alertAt", m.price_usd AS "alertPrice", m.liquidity_usd AS "alertLiquidity"
     FROM alert_events a
     LEFT JOIN LATERAL (
       SELECT price_usd, liquidity_usd FROM market_snapshots
       WHERE token_address = a.token_address AND observed_at >= a.alert_at
       ORDER BY observed_at ASC LIMIT 1
     ) m ON true
     WHERE a.status = 'paper'
     ORDER BY a.alert_at ASC
     LIMIT 100`,
  );
  let labeled = 0;
  for (const alert of alerts.rows) {
    const snapshots = await query(
      `SELECT observed_at AS "observedAt", price_usd AS "priceUsd", liquidity_usd AS "liquidityUsd"
       FROM market_snapshots WHERE token_address = $1 AND observed_at >= $2 ORDER BY observed_at ASC`,
      [alert.tokenAddress, alert.alertAt],
    );
    let completed = 0;
    for (const horizon of Object.keys(OUTCOME_CONFIG)) {
      const outcome = outcomeHorizon(alert, horizon, snapshots.rows);
      if (outcome.status === "pending") continue;
      await query(
        `INSERT INTO outcome_labels (alert_event_id, horizon, label, return_path, mfe, mae, liquidity_path, labeled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (alert_event_id, horizon) DO UPDATE SET label = EXCLUDED.label, return_path = EXCLUDED.return_path, mfe = EXCLUDED.mfe, mae = EXCLUDED.mae, liquidity_path = EXCLUDED.liquidity_path, labeled_at = now()`,
        [alert.id, horizon, outcome.label, JSON.stringify(outcome.returnPath), outcome.mfe, outcome.mae, JSON.stringify(outcome.liquidityPath)],
      );
      completed += 1;
      labeled += 1;
    }
    if (completed === Object.keys(OUTCOME_CONFIG).length) await query(`UPDATE alert_events SET status = 'labeled' WHERE id = $1`, [alert.id]);
  }
  return { labeled };
}

async function runScheduledJob(job) {
  if (scanLock) return { skipped: true, reason: "scan_in_progress" };
  scanLock = true;
  try {
    const result = job === "watchlist" ? await refreshWatchlist() : await scanLive("scheduled");
    if (job === "watchlist") result.outcomes = await labelDueOutcomes();
    return result;
  } finally {
    scanLock = false;
  }
}

function demoFixtures() {
  const base = Date.now();
  return [
    {
      tokenAddress: "DemoOrganicAlpha11111111111111111111111111111",
      pairAddress: "DemoPairOrganic111111111111111111111111111111",
      name: "Organic Alpha",
      symbol: "ALPHA",
      priceUsd: 0.00042,
      liquidityUsd: 84200,
      volume1h: 172000,
      buyTx1h: 128,
      sellTx1h: 64,
      ageMinutes: 74,
      lifecycle: "MOMENTUM_CONFIRMATION",
      regime: "BULLISH",
      label: "WATCHLIST",
      scoreStatus: "provisional",
      signalScore: 71.8,
      priorityScore: 65.9,
      evidenceConfidence: 0.76,
      components: { momentum: 78, holderHealth: 65, flowQuality: 72, liquidityQuality: 81 },
      gates: [
        { name: "security", status: "pass", reasonCode: "SECURITY_CHECKS_PASS", evidence: { mintAuthority: "revoked", freezeAuthority: "revoked", topHolderPercent: 8.2 } },
        { name: "flow_quality", status: "pass", reasonCode: "FLOW_SAMPLE_ACCEPTED", evidence: { uniqueBuyerRatio: 0.43, buyTx: 128 } },
        { name: "clone", status: "pass", reasonCode: "NO_STRONG_COPYCAT_SIGNAL", evidence: { similarity: 0.22 } },
        { name: "divergence", status: "pass", reasonCode: "DIVERGENCE_WITHIN_BOUND", evidence: { divergence: 0.12 } },
        { name: "deployer", status: "unknown", reasonCode: "DEPLOYER_HISTORY_INCOMPLETE", evidence: {} },
        { name: "cluster", status: "pass", reasonCode: "NO_CONFIRMED_COORDINATED_CLUSTER", evidence: { riskScore: 0.09 } },
      ],
      dataMode: "DEMO_FIXTURES",
      lastUpdated: new Date(base - 30000).toISOString(),
    },
    {
      tokenAddress: "DemoQuarantineBeta11111111111111111111111111",
      pairAddress: "DemoPairQuarantine111111111111111111111111111",
      name: "Quarantine Beta",
      symbol: "QUBE",
      priceUsd: 0.0021,
      liquidityUsd: 12400,
      volume1h: 81000,
      buyTx1h: 7,
      sellTx1h: 3,
      ageMinutes: 18,
      lifecycle: "RAYDIUM_EARLY",
      regime: "UNKNOWN",
      label: "QUARANTINED",
      scoreStatus: "unknown",
      signalScore: null,
      priorityScore: null,
      evidenceConfidence: 0.08,
      components: { momentum: null, holderHealth: null, flowQuality: null, liquidityQuality: 41 },
      gates: [
        { name: "security", status: "unknown", reasonCode: "SECURITY_DATA_INCOMPLETE", evidence: { missing: "lp/holder/risk" } },
        { name: "flow_quality", status: "unknown", reasonCode: "FLOW_SAMPLE_TOO_SMALL", evidence: { uniqueBuyers: null, buyTx: 7, minimum: 10 } },
        { name: "clone", status: "unknown", reasonCode: "CLONE_EVIDENCE_UNAVAILABLE", evidence: {} },
        { name: "divergence", status: "unknown", reasonCode: "DIVERGENCE_NOT_MATURE", evidence: { ageMinutes: 18 } },
        { name: "deployer", status: "unknown", reasonCode: "DEPLOYER_HISTORY_INCOMPLETE", evidence: {} },
        { name: "cluster", status: "unknown", reasonCode: "CLUSTER_DATA_UNAVAILABLE", evidence: {} },
      ],
      dataMode: "DEMO_FIXTURES",
      lastUpdated: new Date(base - 45000).toISOString(),
    },
    {
      tokenAddress: "DemoRejectedGamma111111111111111111111111111",
      pairAddress: "DemoPairRejected1111111111111111111111111111",
      name: "Liquidity Mirage",
      symbol: "MIRAGE",
      priceUsd: 0.0094,
      liquidityUsd: 6700,
      volume1h: 119000,
      buyTx1h: 219,
      sellTx1h: 18,
      ageMinutes: 121,
      lifecycle: "OVEREXTENDED",
      regime: "HIGH_VOLATILITY",
      label: "REJECTED",
      scoreStatus: "blocked",
      signalScore: null,
      priorityScore: null,
      evidenceConfidence: 0.69,
      components: { momentum: 96, holderHealth: 22, flowQuality: 18, liquidityQuality: 14 },
      gates: [
        { name: "security", status: "reject", reasonCode: "SECURITY_RISK_CONFIRMED", evidence: { topHolderPercent: 21.4, riskCategory: "danger" } },
        { name: "flow_quality", status: "reject", reasonCode: "COORDINATED_FLOW_CONFIRMED", evidence: { uniqueBuyerRatio: 0.11, buyTx: 219 } },
        { name: "clone", status: "pass", reasonCode: "NO_STRONG_COPYCAT_SIGNAL", evidence: { similarity: 0.37 } },
        { name: "divergence", status: "reject", reasonCode: "PRICE_LIQUIDITY_DIVERGENCE", evidence: { divergence: 0.71 } },
        { name: "deployer", status: "reject", reasonCode: "DEPLOYER_RUG_HISTORY", evidence: { rugCount: 3 } },
        { name: "cluster", status: "reject", reasonCode: "COORDINATED_CLUSTER_CONFIRMED", evidence: { riskScore: 0.91 } },
      ],
      dataMode: "DEMO_FIXTURES",
      lastUpdated: new Date(base - 60000).toISOString(),
    },
  ];
}

app.get("/api/health", async (req, res) => {
  let db = "not_configured";
  if (pool) {
    try { await query("SELECT 1"); db = "connected"; } catch { db = "error"; }
  }
  res.json({ ok: db === "connected", db, modelVersion: MODEL_VERSION, startedAt });
});

app.get("/api/radar", async (req, res) => {
  if (!requireDb(res)) return;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
  const result = await query(
    `SELECT DISTINCT ON (s.token_address)
      s.token_address AS "tokenAddress", s.pair_address AS "pairAddress", t.name, t.symbol,
      m.price_usd AS "priceUsd", m.liquidity_usd AS "liquidityUsd", m.volume_1h AS "volume1h",
      m.buy_tx_1h AS "buyTx1h", m.sell_tx_1h AS "sellTx1h", s.lifecycle, s.market_regime AS "regime",
      s.momentum_score AS momentum, s.holder_health_score AS "holderHealth", s.flow_quality_score AS "flowQuality",
      s.liquidity_quality_score AS "liquidityQuality", s.signal_score AS "signalScore",
      s.priority_score AS "priorityScore", s.evidence_confidence AS "evidenceConfidence",
      s.label, s.score_status AS "scoreStatus", s.evidence, s.penalties, s.observed_at AS "lastUpdated",
      s.model_version AS "modelVersion"
     FROM score_snapshots s JOIN tokens t ON t.token_address = s.token_address
     LEFT JOIN market_snapshots m ON m.token_address = s.token_address
       AND m.observed_at = (SELECT max(m2.observed_at) FROM market_snapshots m2 WHERE m2.token_address = s.token_address)
     ORDER BY s.token_address, s.priority_score DESC NULLS LAST, s.observed_at DESC
     LIMIT $1`,
    [limit],
  );
  res.json({ dataMode: "LIVE_DATABASE", items: result.rows });
});

app.get("/api/demo", (req, res) => {
  res.json({ dataMode: "DEMO_FIXTURES", items: demoFixtures(), disclaimer: "Fixtures only; not live market data." });
});

app.get("/api/token/:address", async (req, res) => {
  if (!requireDb(res)) return;
  const address = req.params.address;
  const token = await query(`SELECT token_address AS "tokenAddress", name, symbol, creator_address AS "creatorAddress", lifecycle, first_seen AS "firstSeen" FROM tokens WHERE token_address = $1`, [address]);
  if (!token.rows[0]) return res.status(404).json({ error: "Token not found" });
  const [score, gates, market] = await Promise.all([
    query(`SELECT * FROM score_snapshots WHERE token_address = $1 ORDER BY observed_at DESC LIMIT 60`, [address]),
    query(`SELECT gate_name AS name, status, reason_code AS "reasonCode", evidence, observed_at AS "observedAt" FROM gate_decisions WHERE token_address = $1 ORDER BY observed_at DESC LIMIT 60`, [address]),
    query(`SELECT * FROM market_snapshots WHERE token_address = $1 ORDER BY observed_at DESC LIMIT 60`, [address]),
  ]);
  res.json({ token: token.rows[0], scores: score.rows, gates: gates.rows, market: market.rows });
});

app.post("/api/scan", async (req, res) => {
  if (!requireDb(res)) return;
  if (scanLock) return res.status(409).json({ error: "A scan is already in progress", code: "SCAN_IN_PROGRESS" });
  scanLock = true;
  try {
    const result = await scanLive("manual");
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: error.message, code: "SCAN_FAILED" });
  } finally {
    scanLock = false;
  }
});

app.get("/api/scan-runs", async (req, res) => {
  if (!requireDb(res)) return;
  const result = await query(`SELECT id, started_at AS "startedAt", finished_at AS "finishedAt", mode, candidates_seen AS "candidatesSeen", observations_saved AS "observationsSaved", passed, rejected, unknown, errors FROM scan_runs ORDER BY started_at DESC LIMIT 20`);
  res.json({ items: result.rows });
});

app.get("/api/precision-report", async (req, res) => {
  if (!requireDb(res)) return;
  const result = await query(`SELECT horizon, label, mfe, mae, labeled_at AS "labeledAt" FROM outcome_labels WHERE label IS NOT NULL ORDER BY labeled_at DESC`);
  res.json({ ...precisionReport(result.rows), dataMode: "LIVE_DATABASE" });
});

app.get("/api/alerts", async (req, res) => {
  if (!requireDb(res)) return;
  const result = await query(
    `SELECT a.id, a.token_address AS "tokenAddress", t.name, t.symbol, a.alert_type AS "alertType",
            a.alert_at AS "alertAt", a.status, a.evidence,
            COUNT(o.id)::int AS "outcomeCount"
     FROM alert_events a JOIN tokens t ON t.token_address = a.token_address
     LEFT JOIN outcome_labels o ON o.alert_event_id = a.id
     GROUP BY a.id, t.name, t.symbol
     ORDER BY a.alert_at DESC LIMIT 100`,
  );
  res.json({ items: result.rows });
});

const distPath = path.join(__dirname, "..", "dist");
app.use(express.static(distPath));
app.use((req, res, next) => {
  if (req.method === "GET" && req.accepts("html")) {
    return res.sendFile(path.join(distPath, "index.html"), (error) => {
      if (error) next(error);
    });
  }
  return next();
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Radar listening on http://0.0.0.0:${PORT}`);
  if (process.env.RADAR_SCHEDULER_ENABLED === "true") {
    console.log("Scheduler enabled: discovery 120s / watchlist 30s");
    setTimeout(() => runScheduledJob("discovery").catch((error) => console.error("scheduled discovery:", error.message)), 5000);
    setInterval(() => runScheduledJob("discovery").catch((error) => console.error("scheduled discovery:", error.message)), 120000);
    setInterval(() => runScheduledJob("watchlist").catch((error) => console.error("scheduled watchlist:", error.message)), 30000);
  } else {
    console.log("Scheduler disabled; use Scan live market for a controlled run.");
  }
});