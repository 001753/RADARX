const MODEL_VERSION = "radar-v1.2.0";
const GATE_VERSION = "gate-v1.2";
const ACTIVE_WEIGHTS = Object.freeze({
  momentum: 0.5455,
  holderHealth: 0.4545,
});

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : min));
}

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function pctRank(value, cohort = []) {
  const numeric = cohort.map(Number).filter(Number.isFinite);
  if (!Number.isFinite(Number(value)) || numeric.length < 2) return null;
  return (numeric.filter((item) => item < Number(value)).length / numeric.length) * 100;
}

function safeRatio(numerator, denominator) {
  if (!Number.isFinite(Number(numerator)) || !Number.isFinite(Number(denominator)) || Number(denominator) === 0) return null;
  return Number(numerator) / Number(denominator);
}

function normalizedSimilarity(left = "", right = "") {
  const a = String(left).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const b = String(right).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  if (!a || !b) return null;
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = a[i - 1] === b[j - 1]
        ? rows[i - 1][j - 1]
        : Math.min(rows[i - 1][j - 1] + 1, rows[i][j - 1] + 1, rows[i - 1][j] + 1);
    }
  }
  return 1 - rows[a.length][b.length] / Math.max(a.length, b.length);
}

function computeGini(values = []) {
  const numbers = values.map(Number).filter(Number.isFinite).map((n) => Math.max(0, n)).sort((a, b) => a - b);
  const total = numbers.reduce((sum, n) => sum + n, 0);
  if (!numbers.length || total === 0) return null;
  const weighted = numbers.reduce((sum, n, index) => sum + (index + 1) * n, 0);
  return (2 * weighted) / (numbers.length * total) - (numbers.length + 1) / numbers.length;
}

function classifyLifecycle(input) {
  const age = finite(input.ageMinutes);
  const migration = input.migrationConfirmed === true;
  const liquidity = finite(input.liquidityUsd);
  const priceReturn = finite(input.priceReturn30m);
  if (age === null) return "UNKNOWN";
  if (age < 5) return "NEW";
  if (!migration && age < 45) return "BONDING_CURVE";
  if (migration && age < 45) return "RAYDIUM_EARLY";
  if (priceReturn !== null && priceReturn > 0.45) return "OVEREXTENDED";
  if (priceReturn !== null && priceReturn < -0.2) return "DECAYING";
  if (liquidity !== null && liquidity > 10000 && age < 180) return "MOMENTUM_CONFIRMATION";
  return "EARLY_DISCOVERY";
}

function classifyRegime(input) {
  const baseline = finite(input.marketBaseline1h);
  const liquidityTrend = finite(input.marketLiquidityTrend);
  if (baseline === null || liquidityTrend === null) return "UNKNOWN";
  if (liquidityTrend < -0.15) return "LIQUIDITY_CONTRACTION";
  if (baseline < -0.08) return "RISK_OFF";
  if (Math.abs(baseline) > 0.2) return "HIGH_VOLATILITY";
  if (baseline > 0.05) return "BULLISH";
  return "NEUTRAL";
}

function gate(name, status, reasonCode, evidence = {}) {
  return { name, status, reasonCode, evidence, version: GATE_VERSION };
}

function evaluateGates(input) {
  const decisions = [];
  const security = input.security || {};
  const securityCriticalMissing = [
    security.mintAuthority,
    security.freezeAuthority,
    security.lpState,
    security.topHolderPercent,
    security.riskCategory,
  ].some((value) => value === undefined || value === null);
  if (securityCriticalMissing) {
    decisions.push(gate("security", "unknown", "SECURITY_DATA_INCOMPLETE", { missing: "mint/freeze/lp/holder/risk" }));
  } else if (
    security.mintAuthority === "active" ||
    security.freezeAuthority === "active" ||
    security.lpState === "unverified" ||
    security.topHolderPercent > 15 ||
    security.riskCategory === "danger"
  ) {
    decisions.push(gate("security", "reject", "SECURITY_RISK_CONFIRMED", security));
  } else {
    decisions.push(gate("security", "pass", "SECURITY_CHECKS_PASS", security));
  }

  const buyTx = finite(input.buyTx1h);
  const uniqueBuyers = finite(input.uniqueBuyers1h);
  const ratio = buyTx !== null && uniqueBuyers !== null && buyTx > 0 ? uniqueBuyers / buyTx : null;
  if (buyTx === null || uniqueBuyers === null || buyTx < 10) {
    decisions.push(gate("flow_quality", "unknown", "FLOW_SAMPLE_TOO_SMALL", { buyTx, uniqueBuyers, minimum: 10 }));
  } else if (ratio < 0.15 && input.flowEvidenceConfirmed === true) {
    decisions.push(gate("flow_quality", "reject", "COORDINATED_FLOW_CONFIRMED", { uniqueBuyerRatio: ratio, buyTx }));
  } else {
    decisions.push(gate("flow_quality", "pass", ratio < 0.15 ? "FLOW_SUSPICIOUS_NOT_CONFIRMED" : "FLOW_SAMPLE_ACCEPTED", { uniqueBuyerRatio: ratio, buyTx }));
  }

  const cloneSimilarity = finite(input.cloneSimilarity);
  if (cloneSimilarity === null) {
    decisions.push(gate("clone", "unknown", "CLONE_EVIDENCE_UNAVAILABLE"));
  } else if (cloneSimilarity >= 0.8 && input.cloneEvidenceConfirmed === true) {
    decisions.push(gate("clone", "reject", "COPYCAT_CONFIRMED", { similarity: cloneSimilarity }));
  } else {
    decisions.push(gate("clone", "pass", cloneSimilarity >= 0.8 ? "COPYCAT_NOT_CONFIRMED" : "NO_STRONG_COPYCAT_SIGNAL", { similarity: cloneSimilarity }));
  }

  const priceReturn = finite(input.priceReturn30m);
  const liqReturn = finite(input.liquidityReturn30m);
  const divergence = priceReturn !== null && liqReturn !== null ? priceReturn - liqReturn : null;
  if (divergence === null || finite(input.liquidityUsd) === null || finite(input.ageMinutes) === null || input.ageMinutes < 30) {
    decisions.push(gate("divergence", "unknown", "DIVERGENCE_NOT_MATURE", { divergence, ageMinutes: input.ageMinutes }));
  } else if (divergence > 0.4) {
    decisions.push(gate("divergence", "reject", "PRICE_LIQUIDITY_DIVERGENCE", { divergence }));
  } else {
    decisions.push(gate("divergence", "pass", "DIVERGENCE_WITHIN_BOUND", { divergence }));
  }

  const dev = input.dev || {};
  if (dev.rugCount === undefined || dev.successCount === undefined || dev.attributionConfirmed !== true) {
    decisions.push(gate("deployer", "unknown", "DEPLOYER_HISTORY_INCOMPLETE", { attributionConfirmed: dev.attributionConfirmed === true }));
  } else if (dev.rugCount >= 2) {
    decisions.push(gate("deployer", "reject", "DEPLOYER_RUG_HISTORY", { rugCount: dev.rugCount }));
  } else {
    decisions.push(gate("deployer", "pass", "DEPLOYER_HISTORY_ACCEPTED", dev));
  }

  const cluster = input.cluster || {};
  if (cluster.riskScore === undefined) {
    decisions.push(gate("cluster", "unknown", "CLUSTER_DATA_UNAVAILABLE"));
  } else if (cluster.riskScore >= 0.8 && cluster.confirmed === true) {
    decisions.push(gate("cluster", "reject", "COORDINATED_CLUSTER_CONFIRMED", cluster));
  } else {
    decisions.push(gate("cluster", "pass", "NO_CONFIRMED_COORDINATED_CLUSTER", cluster));
  }

  return decisions;
}

function scoreComponents(input, cohort = {}) {
  const market = input;
  const liquidity = finite(market.liquidityUsd);
  const vlr5m = liquidity && liquidity > 0 ? safeRatio(market.volume5m, liquidity) : null;
  const vlr1h = liquidity && liquidity > 0 ? safeRatio(market.volume1h, liquidity) : null;
  const bsr = safeRatio(market.buyTx1h, (finite(market.buyTx1h) || 0) + (finite(market.sellTx1h) || 0));
  const accel = finite(market.volume6h) && market.volume6h > 0 && finite(market.volume1h) !== null
    ? market.volume1h / (market.volume6h / 6) - 1
    : null;
  const trendQ = finite(market.trendQ);
  const relativeMomentum = finite(market.priceChange1h) !== null && finite(market.marketBaseline1h) !== null
    ? market.priceChange1h - market.marketBaseline1h
    : null;
  const momentumParts = [
    [0.25, pctRank(vlr5m, cohort.vlr5m)],
    [0.20, pctRank(vlr1h, cohort.vlr1h)],
    [0.20, pctRank(bsr, cohort.bsr)],
    [0.15, pctRank(accel, cohort.accel)],
    [0.10, pctRank(trendQ, cohort.trendQ)],
    [0.10, pctRank(relativeMomentum, cohort.relativeMomentum)],
  ];
  const momentumAvailable = momentumParts.filter(([, value]) => value !== null);
  const momentum = momentumAvailable.length >= 3
    ? momentumAvailable.reduce((sum, [weight, value]) => sum + weight * value, 0) / momentumAvailable.reduce((sum, [weight]) => sum + weight, 0)
    : null;

  const growth = finite(market.holderGrowth);
  const distribution = finite(market.holderDistribution);
  const retention = finite(market.holderRetention);
  const holderParts = [
    [0.40, pctRank(growth, cohort.holderGrowth)],
    [0.35, pctRank(distribution, cohort.holderDistribution)],
    [0.25, pctRank(retention, cohort.holderRetention)],
  ];
  const holderAvailable = holderParts.filter(([, value]) => value !== null);
  const holderHealth = holderAvailable.length >= 2
    ? holderAvailable.reduce((sum, [weight, value]) => sum + weight * value, 0) / holderAvailable.reduce((sum, [weight]) => sum + weight, 0)
    : null;

  const uniqueRatio = finite(market.uniqueBuyerRatio);
  const concentration = finite(market.buyConcentration);
  const flowQuality = uniqueRatio !== null
    ? clamp((clamp(uniqueRatio / 0.55) * 70 + (concentration === null ? 0 : clamp(1 - concentration) * 30)) / 100) * 100
    : null;
  const liqTrend = finite(market.liquidityReturn30m);
  const liqQuality = liquidity !== null
    ? clamp((Math.min(1, liquidity / 100000) * 0.45) + (finite(market.slippageBps) === null ? 0.2 : clamp(1 - market.slippageBps / 5000) * 0.35) + (liqTrend === null ? 0.2 : clamp((liqTrend + 0.25) / 0.5) * 0.2)) * 100
    : null;

  return {
    momentum,
    holderHealth,
    flowQuality,
    liquidityQuality: liqQuality,
    rawInputs: { vlr5m, vlr1h, bsr, accel, trendQ, relativeMomentum, uniqueRatio },
  };
}

function calculateScore(input, cohort = {}) {
  const lifecycle = classifyLifecycle(input);
  const regime = classifyRegime(input);
  const components = scoreComponents(input, cohort);
  const gates = evaluateGates(input);
  const rejected = gates.find((decision) => decision.status === "reject");
  const unknownCritical = gates.some((decision) => decision.status === "unknown" && ["security", "flow_quality", "deployer"].includes(decision.name));
  const componentValues = { momentum: components.momentum, holderHealth: components.holderHealth };
  const available = Object.entries(componentValues).filter(([, value]) => value !== null);
  const scorePending = available.length < 2 || available.some(([, value]) => value === null);
  const rawScore = !scorePending
    ? available.reduce((sum, [key, value]) => sum + ACTIVE_WEIGHTS[key] * value, 0)
    : null;
  const washPenalty = finite(input.uniqueBuyerRatio) === null ? 0.65 : input.uniqueBuyerRatio < 0.15 ? 0.4 : input.uniqueBuyerRatio < 0.30 ? 0.75 : 1;
  const liqSlopePct = finite(input.liquiditySlopePct);
  const baseLiqMultiplier = liqSlopePct === null ? null : clamp(0.6 + 0.4 * clamp((liqSlopePct + 100) / 200));
  const liquidityStability = baseLiqMultiplier === null ? null : (finite(input.liquidityReturn30m) < -0.1 ? Math.min(baseLiqMultiplier, 0.4) : baseLiqMultiplier);
  const signalScore = rawScore !== null && liquidityStability !== null ? clamp(rawScore * washPenalty * liquidityStability / 100) * 100 : null;
  const maturity = finite(input.ageMinutes) === null ? 0 : clamp(input.ageMinutes / 30);
  const sampleQuality = finite(input.buyTx1h) === null ? 0 : clamp(Math.sqrt(Math.max(0, input.buyTx1h) / 50));
  const dataQuality = finite(input.dataQuality) === null ? 0 : clamp(input.dataQuality);
  const evidenceConfidence = maturity * sampleQuality * dataQuality;
  const priorityScore = signalScore === null ? null : signalScore * (0.5 + 0.5 * evidenceConfidence);
  let label = "NO_CALL";
  let scoreStatus = "pending";
  if (rejected) {
    label = "REJECTED";
    scoreStatus = "blocked";
  } else if (unknownCritical) {
    label = "QUARANTINED";
    scoreStatus = "unknown";
  } else if (signalScore !== null && evidenceConfidence >= 0.7 && signalScore >= 80) {
    label = "HIGH_PRIORITY";
    scoreStatus = "confirmed";
  } else if (signalScore !== null && evidenceConfidence >= 0.5 && signalScore >= 60) {
    label = "WATCHLIST";
    scoreStatus = "provisional";
  } else if (signalScore !== null) {
    label = "PROVISIONAL";
    scoreStatus = "measured";
  }
  return {
    lifecycle,
    regime,
    gates,
    components,
    rawScore,
    signalScore,
    evidenceConfidence,
    priorityScore,
    label,
    scoreStatus,
    penalties: { washPenalty, liquidityStability },
    activeWeights: ACTIVE_WEIGHTS,
    modelVersion: MODEL_VERSION,
    evidence: {
      lifecycle,
      regime,
      missing: [
        components.momentum === null ? "momentum_cohort" : null,
        components.holderHealth === null ? "holder_history" : null,
        liquidityStability === null ? "liquidity_history" : null,
      ].filter(Boolean),
    },
  };
}

module.exports = {
  MODEL_VERSION,
  GATE_VERSION,
  ACTIVE_WEIGHTS,
  clamp,
  pctRank,
  computeGini,
  normalizedSimilarity,
  classifyLifecycle,
  classifyRegime,
  evaluateGates,
  scoreComponents,
  calculateScore,
};