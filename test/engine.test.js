const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateScore, evaluateGates, normalizedSimilarity } = require("../server/engine");
const { outcomeHorizon, precisionReport, wilsonLowerBound } = require("../server/evaluator");
const { CONTRACT, validateContract } = require("../server/contract");
const { loadBenchmarkFixtures, validateBenchmarkFixtures, runBaselineBenchmark } = require("../server/benchmark");

test("unknown security evidence never becomes pass", () => {
  const gates = evaluateGates({ buyTx1h: 20, uniqueBuyers1h: 10, ageMinutes: 40, liquidityUsd: 10000 });
  assert.equal(gates.find((gate) => gate.name === "security").status, "unknown");
});

test("confirmed severe risks block the score", () => {
  const result = calculateScore({
    ageMinutes: 90,
    liquidityUsd: 90000,
    volume5m: 50000,
    volume1h: 200000,
    volume6h: 600000,
    buyTx1h: 100,
    sellTx1h: 30,
    priceChange1h: 0.3,
    marketBaseline1h: 0.02,
    liquiditySlopePct: 20,
    liquidityReturn30m: 0.1,
    dataQuality: 1,
    security: { mintAuthority: "active", freezeAuthority: "revoked", lpState: "verified", topHolderPercent: 5, riskCategory: "review" },
    uniqueBuyerRatio: 0.4,
    holderGrowth: 0.2,
    holderDistribution: 0.8,
    holderRetention: 0.9,
    trendQ: 0.8,
  }, {
    vlr5m: [0.1, 0.2, 0.3], vlr1h: [1, 2, 3], bsr: [0.3, 0.5, 0.7], accel: [0, .5, 1],
    trendQ: [.2, .5, .8], relativeMomentum: [0, .1, .2], holderGrowth: [0, .1, .2],
    holderDistribution: [.4, .6, .8], holderRetention: [.5, .7, .9],
  });
  assert.equal(result.label, "REJECTED");
  assert.equal(result.gates.find((gate) => gate.name === "security").status, "reject");
});

test("similarity is normalized and bounded", () => {
  assert.equal(normalizedSimilarity("SOL CAT", "sol-cat"), 1);
  assert.ok(normalizedSimilarity("alpha", "omega") >= 0);
  assert.ok(normalizedSimilarity("alpha", "omega") <= 1);
});

test("outcome labels stay pending until the configured horizon is complete", () => {
  const result = outcomeHorizon(
    { alertAt: "2026-01-01T00:00:00.000Z", alertPrice: 1, alertLiquidity: 1000 },
    "HYPE_1H",
    [{ observedAt: "2026-01-01T00:20:00.000Z", priceUsd: 1.4, liquidityUsd: 1000 }],
  );
  assert.equal(result.status, "pending");
});

test("precision report refuses small samples and exposes conservative bound", () => {
  const outcomes = Array.from({ length: 30 }, (_, index) => ({ horizon: "HYPE_1H", label: index < 24 ? "HIT" : "MISS" }));
  const report = precisionReport(outcomes);
  assert.equal(report.status, "INSUFFICIENT_DATA");
  assert.equal(report.horizons[0].total, 30);
  assert.ok(wilsonLowerBound(24, 30) < 0.8);
});

test("precision contract is versioned, normalized, and complete", () => {
  assert.equal(validateContract(), true);
  assert.equal(CONTRACT.contractVersion, "precision-contract-v1.2");
  assert.equal(Object.values(CONTRACT.weights).reduce((sum, value) => sum + value, 0), 1);
});

test("phase 0 benchmark covers all required failure modes and has no label mismatch", () => {
  const fixtures = loadBenchmarkFixtures();
  const validation = validateBenchmarkFixtures(fixtures);
  assert.equal(validation.scenarioCount, 10);
  const report = runBaselineBenchmark(fixtures);
  assert.deepEqual(report.expectedMismatches, []);
  assert.ok(report.baselines.volume_only.measured > 0);
});