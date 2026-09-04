const fs = require("node:fs");
const path = require("node:path");

const CONTRACT_PATH = path.join(__dirname, "..", "config", "precision-contract.v1.2.json");
const CONTRACT = Object.freeze(JSON.parse(fs.readFileSync(CONTRACT_PATH, "utf8")));

function assertFiniteBetween(value, min, max, label) {
  if (!Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
}

function validateContract(contract = CONTRACT) {
  if (!contract.contractVersion || !contract.modelVersion) throw new Error("contractVersion and modelVersion are required");
  assertFiniteBetween(contract.target.precision, 0, 1, "target.precision");
  assertFiniteBetween(contract.target.coverage, 0, 1, "target.coverage");
  if (!Number.isInteger(contract.target.minOutcomeSamplesPerHorizon) || contract.target.minOutcomeSamplesPerHorizon < 30) {
    throw new Error("target.minOutcomeSamplesPerHorizon must be an integer >= 30");
  }
  if (!Number.isInteger(contract.target.maxHighPriorityAlertsPerHour) || contract.target.maxHighPriorityAlertsPerHour < 1) {
    throw new Error("target.maxHighPriorityAlertsPerHour must be a positive integer");
  }
  const weightSum = Object.values(contract.weights).reduce((sum, value) => sum + Number(value), 0);
  if (Math.abs(weightSum - 1) > 0.00001) throw new Error(`active weights must sum to 1.0, got ${weightSum}`);
  for (const [name, outcome] of Object.entries(contract.outcomes)) {
    if (!Number.isInteger(outcome.horizonMinutes) || outcome.horizonMinutes <= 0) throw new Error(`${name}.horizonMinutes is invalid`);
    if (name.startsWith("HYPE_")) {
      assertFiniteBetween(outcome.targetNetReturn, 0, 10, `${name}.targetNetReturn`);
      assertFiniteBetween(outcome.maxDrawdown, 0, 1, `${name}.maxDrawdown`);
      assertFiniteBetween(outcome.liquidityFloorRatio, 0, 1, `${name}.liquidityFloorRatio`);
    }
  }
  const required = new Set(contract.benchmark.requiredCategories);
  if (required.size !== contract.benchmark.requiredCategories.length) throw new Error("benchmark categories must be unique");
  if (required.size < 10) throw new Error("benchmark must cover at least 10 required categories");
  return true;
}

validateContract();

module.exports = {
  CONTRACT,
  CONTRACT_PATH,
  validateContract,
};