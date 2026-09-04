const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { CONTRACT, validateContract } = require("./contract");
const { outcomeHorizon, survivalOutcome } = require("./evaluator");

const FIXTURE_PATH = path.join(__dirname, "..", "benchmark", "precision-v1.2.json");

function loadBenchmarkFixtures(filePath = FIXTURE_PATH) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function validateBenchmarkFixtures(fixtures = loadBenchmarkFixtures()) {
  validateContract();
  if (fixtures.contractVersion !== CONTRACT.contractVersion) throw new Error("benchmark contractVersion does not match the active contract");
  if (!Array.isArray(fixtures.scenarios)) throw new Error("benchmark scenarios must be an array");
  const required = new Set(CONTRACT.benchmark.requiredCategories);
  const seenCategories = new Set();
  const seenIds = new Set();
  for (const scenario of fixtures.scenarios) {
    if (!scenario.id || seenIds.has(scenario.id)) throw new Error(`duplicate or missing scenario id: ${scenario.id}`);
    seenIds.add(scenario.id);
    if (!required.has(scenario.category)) throw new Error(`unexpected benchmark category: ${scenario.category}`);
    seenCategories.add(scenario.category);
    if (!validDate(scenario.alertAt) || scenario.event?.alertAt !== scenario.alertAt) throw new Error(`${scenario.id} alert timestamp is invalid or inconsistent`);
    if (!scenario.event || !scenario.expected || !Array.isArray(scenario.snapshots)) throw new Error(`${scenario.id} is missing event, expected, or snapshots`);
    let previous = new Date(scenario.alertAt).getTime();
    for (const snapshot of scenario.snapshots) {
      const observed = new Date(snapshot.observedAt).getTime();
      if (!validDate(snapshot.observedAt) || observed < previous) throw new Error(`${scenario.id} snapshots must be chronological and post-alert`);
      previous = observed;
    }
    for (const horizon of ["HYPE_1H", "SURVIVAL", "RISK_EVENT"]) {
      if (!["HIT", "MISS", "RISK_EVENT", "SURVIVED", "NO_EVENT", "PENDING"].includes(scenario.expected[horizon])) {
        throw new Error(`${scenario.id} has invalid expected ${horizon}`);
      }
    }
  }
  const missing = [...required].filter((category) => !seenCategories.has(category));
  if (missing.length) throw new Error(`benchmark categories missing: ${missing.join(", ")}`);
  return { scenarioCount: fixtures.scenarios.length, categories: [...seenCategories] };
}

function labelScenario(scenario) {
  const hype = outcomeHorizon(scenario.event, CONTRACT.benchmark.primaryHorizon, scenario.snapshots);
  const survival = survivalOutcome(scenario.event, scenario.snapshots);
  const risk = survival.status === "risk_event" ? "RISK_EVENT" : survival.status === "survived" ? "NO_EVENT" : "PENDING";
  return { hype: hype.label || "PENDING", survival: survival.label || "PENDING", risk };
}

function deterministicControl(id, modulo) {
  const hash = crypto.createHash("sha256").update(id).digest("hex");
  return parseInt(hash.slice(0, 8), 16) % modulo === 0;
}

function baselineAlert(scenario, strategy) {
  const features = scenario.features || {};
  const volume = Number(features.volume1h);
  const liquidity = Number(features.liquidityUsd);
  const vlr = Number.isFinite(volume) && Number.isFinite(liquidity) && liquidity > 0 ? volume / liquidity : null;
  const rules = CONTRACT.benchmark.baselineRules;
  if (strategy === "volume_only") return Number.isFinite(volume) && volume >= rules.volumeOnlyMinVolume1h;
  if (strategy === "vlr_only") return vlr !== null && vlr >= rules.vlrOnlyMinVlr1h;
  if (strategy === "top_volume") return Number.isFinite(volume) && volume >= rules.topVolumeMinVolume1h;
  if (strategy === "random_control") return deterministicControl(scenario.id, rules.randomControlModulo);
  throw new Error(`unknown baseline strategy: ${strategy}`);
}

function runBaselineBenchmark(fixtures = loadBenchmarkFixtures()) {
  validateBenchmarkFixtures(fixtures);
  const labeled = fixtures.scenarios.map((scenario) => ({ scenario, outcome: labelScenario(scenario) }));
  const baselines = Object.fromEntries(CONTRACT.benchmark.baselines.map((strategy) => {
    const alerts = labeled.filter(({ scenario }) => baselineAlert(scenario, strategy));
    const measured = alerts.filter(({ outcome }) => outcome.hype !== "PENDING");
    const hits = measured.filter(({ outcome }) => outcome.hype === "HIT").length;
    const alertCount = alerts.length;
    return [strategy, {
      alerts: alertCount,
      measured: measured.length,
      hits,
      precision: measured.length ? hits / measured.length : null,
      coverage: alertCount / fixtures.scenarios.length,
      falsePositiveRate: measured.length ? (measured.length - hits) / measured.length : null,
    }];
  }));
  const expectedMismatches = labeled.flatMap(({ scenario, outcome }) => {
    const mismatches = [];
    if (scenario.expected.HYPE_1H !== "PENDING" && scenario.expected.HYPE_1H !== outcome.hype) mismatches.push("HYPE_1H");
    if (scenario.expected.SURVIVAL !== "PENDING" && scenario.expected.SURVIVAL !== outcome.survival) mismatches.push("SURVIVAL");
    if (scenario.expected.RISK_EVENT !== "PENDING" && scenario.expected.RISK_EVENT !== outcome.risk) mismatches.push("RISK_EVENT");
    return mismatches.length ? [{ id: scenario.id, mismatches, actual: outcome }] : [];
  });
  return {
    benchmarkVersion: fixtures.benchmarkVersion,
    contractVersion: CONTRACT.contractVersion,
    primaryHorizon: CONTRACT.benchmark.primaryHorizon,
    scenarioCount: fixtures.scenarios.length,
    baselines,
    expectedMismatches,
  };
}

if (require.main === module) {
  try {
    const fixtures = loadBenchmarkFixtures();
    const report = runBaselineBenchmark(fixtures);
    console.log(JSON.stringify(report, null, 2));
    if (report.expectedMismatches.length) process.exitCode = 1;
  } catch (error) {
    console.error(`Benchmark invalid: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  FIXTURE_PATH,
  loadBenchmarkFixtures,
  validateBenchmarkFixtures,
  labelScenario,
  runBaselineBenchmark,
};