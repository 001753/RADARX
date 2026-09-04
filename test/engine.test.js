const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateScore, evaluateGates, normalizedSimilarity } = require("../server/engine");

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