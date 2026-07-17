"use strict";

const scenarios = new Set(["cache", "stream", "pubsub", "ingestion", "semantic-cache", "checkpoint"]);
const namespacePattern = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

function positive(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  return Number.isInteger(value) && value > 0;
}

function validLiveEndpoint(value) {
  try {
    const endpoint = new URL(value);
    return endpoint.protocol === "rediss:" && endpoint.port === "10000" && endpoint.hostname.length > 0;
  } catch {
    return false;
  }
}

const mode = process.env.SOAK_MODE ?? "dry-run";
const scenario = process.env.SOAK_SCENARIO ?? "cache";
const keyNamespace = process.env.SOAK_KEY_NAMESPACE ?? "soak:offline";
let invalid = !["dry-run", "live"].includes(mode) || !scenarios.has(scenario) || !namespacePattern.test(keyNamespace) ||
  !positive("SOAK_TIMEOUT_MS", 750) || !positive("SOAK_MAX_RETRIES", 3) || !positive("SOAK_TTL_SECONDS", 60);
if (mode === "live" && !validLiveEndpoint(process.env.REDIS_ENDPOINT ?? "")) {
  invalid = true;
}
const status = invalid ? "invalid-config" : mode === "live" ? "live-adapter-required" : "ok";
const succeeded = status === "ok" ? 1 : 0;
console.log(JSON.stringify({
  library: "node-redis",
  mode,
  scenario,
  status,
  keyNamespace,
  probeKey: `${keyNamespace}:${scenario}:probe`,
  metrics: { attempted: 1, succeeded, failed: 1 - succeeded, latencyMs: 0 }
}));
process.exitCode = invalid ? 2 : 0;
