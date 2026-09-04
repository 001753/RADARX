const OUTCOME_CONFIG = Object.freeze({
  HYPE_1H: { minutes: 60, targetReturn: 0.30, maxDrawdown: 0.20 },
  HYPE_6H: { minutes: 360, targetReturn: 0.50, maxDrawdown: 0.30 },
  HYPE_24H: { minutes: 1440, targetReturn: 0.75, maxDrawdown: 0.40 },
});

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function wilsonLowerBound(successes, total, z = 1.96) {
  const n = Number(total);
  const positive = Number(successes);
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(positive) || positive < 0 || positive > n) return null;
  const p = positive / n;
  const denominator = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return Math.max(0, (center - margin) / denominator);
}

function outcomeHorizon(event, horizon, snapshots, config = OUTCOME_CONFIG[horizon]) {
  if (!config || finite(event.alertPrice) === null || !event.alertAt) {
    return { horizon, status: "pending", reason: "ALERT_PRICE_OR_TIME_MISSING" };
  }
  const alertTime = new Date(event.alertAt).getTime();
  const endTime = alertTime + config.minutes * 60000;
  const path = snapshots
    .map((snapshot) => ({
      observedAt: snapshot.observedAt || snapshot.observed_at,
      price: finite(snapshot.priceUsd ?? snapshot.price_usd),
      liquidity: finite(snapshot.liquidityUsd ?? snapshot.liquidity_usd),
    }))
    .filter((snapshot) => snapshot.price !== null && new Date(snapshot.observedAt).getTime() >= alertTime && new Date(snapshot.observedAt).getTime() <= endTime)
    .sort((a, b) => new Date(a.observedAt) - new Date(b.observedAt));
  if (!path.length) return { horizon, status: "pending", reason: "HORIZON_DATA_NOT_READY" };
  const startPrice = Number(event.alertPrice);
  let mfe = 0;
  let mae = 0;
  let hit = false;
  let hitAt = null;
  let riskEvent = false;
  const returnPath = path.map((point) => {
    const returnValue = point.price / startPrice - 1;
    mfe = Math.max(mfe, returnValue);
    mae = Math.min(mae, returnValue);
    if (point.liquidity !== null && event.alertLiquidity !== null && point.liquidity < event.alertLiquidity * 0.4) riskEvent = true;
    if (!hit && returnValue >= config.targetReturn && mae >= -config.maxDrawdown) {
      hit = true;
      hitAt = point.observedAt;
    }
    return { observedAt: point.observedAt, return: returnValue, liquidity: point.liquidity };
  });
  const complete = new Date(path[path.length - 1].observedAt).getTime() >= endTime;
  if (!complete) return { horizon, status: "pending", reason: "HORIZON_DATA_NOT_COMPLETE", observedUntil: path[path.length - 1].observedAt };
  return {
    horizon,
    status: riskEvent ? "risk_event" : hit ? "hit" : "miss",
    label: riskEvent ? "RISK_EVENT" : hit ? "HIT" : "MISS",
    mfe,
    mae,
    hitAt,
    returnPath,
    liquidityPath: returnPath.map(({ observedAt, liquidity }) => ({ observedAt, liquidity })),
  };
}

function precisionReport(outcomes = [], targetPrecision = 0.7, minSample = 30) {
  const horizons = Object.keys(OUTCOME_CONFIG).map((horizon) => {
    const rows = outcomes.filter((outcome) => outcome.horizon === horizon && ["HIT", "MISS", "RISK_EVENT"].includes(outcome.label));
    const successes = rows.filter((outcome) => outcome.label === "HIT").length;
    const total = rows.length;
    const precision = total ? successes / total : null;
    const lowerBound = wilsonLowerBound(successes, total);
    return {
      horizon,
      successes,
      total,
      precision,
      lowerBound,
      status: total < minSample ? "INSUFFICIENT_DATA" : lowerBound >= targetPrecision ? "MEETS_TARGET" : "BELOW_TARGET",
    };
  });
  const measured = horizons.filter((item) => item.total > 0);
  return {
    status: measured.some((item) => item.status === "MEETS_TARGET") ? "MEASURED" : "INSUFFICIENT_DATA",
    targetPrecision,
    minSample,
    horizons,
    evaluatedAt: new Date().toISOString(),
  };
}

module.exports = {
  OUTCOME_CONFIG,
  wilsonLowerBound,
  outcomeHorizon,
  precisionReport,
};