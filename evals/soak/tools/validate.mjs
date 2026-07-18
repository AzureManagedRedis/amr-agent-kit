#!/usr/bin/env node
// Dependency-free validator for the soak source-oracle registry.
// Uses only Node's built-in modules (node:fs, node:path). No npm dependencies.
//
// It performs three passes:
//   1. Schema validation of every catalog item and scenario against a
//      self-contained JSON Schema subset (draft 2020-12, no $ref).
//   2. Referential-integrity validation across the registry (every id-ref
//      resolves to a defined id in the shared catalogs).
//   3. Fixture validation: each fixture must validate (or fail) exactly as
//      declared in fixtures/fixtures.manifest.json.
//
// Exit code 0 = all passed, 1 = one or more failures.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const soakRoot = path.resolve(here, "..");
const schemasDir = path.join(soakRoot, "schemas");
const registryDir = path.join(soakRoot, "registry");
const fixturesDir = path.join(soakRoot, "fixtures");

const errors = [];
const notes = [];
function fail(where, msg) { errors.push(`${where}: ${msg}`); }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { fail(path.relative(soakRoot, file), `invalid JSON (${e.message})`); return undefined; }
}

// ---- Minimal JSON Schema subset validator ------------------------------
function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v; // string | number | boolean | object
}

function matchesType(value, t) {
  if (t === "integer") return typeOf(value) === "integer";
  if (t === "number") return typeof value === "number";
  if (t === "object") return typeOf(value) === "object";
  if (t === "array") return Array.isArray(value);
  if (t === "null") return value === null;
  return typeof value === t;
}

function validate(schema, value, pathStr, out) {
  if (schema === true) return;
  if (schema === false) { out.push(`${pathStr}: schema is false`); return; }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      out.push(`${pathStr}: expected type ${types.join("|")}, got ${typeOf(value)}`);
      return; // further checks unreliable
    }
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    out.push(`${pathStr}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    out.push(`${pathStr}: value ${JSON.stringify(value)} not in enum`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${pathStr}: shorter than minLength ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${pathStr}: longer than maxLength ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) out.push(`${pathStr}: does not match pattern ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${pathStr}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${pathStr}: above maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${pathStr}: fewer than minItems ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${pathStr}: more than maxItems ${schema.maxItems}`);
    if (schema.uniqueItems) {
      const seen = new Set();
      for (const it of value) { const k = JSON.stringify(it); if (seen.has(k)) { out.push(`${pathStr}: duplicate items`); break; } seen.add(k); }
    }
    if (schema.items) value.forEach((it, i) => validate(schema.items, it, `${pathStr}[${i}]`, out));
  }
  if (typeOf(value) === "object") {
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) if (!(req in value)) out.push(`${pathStr}: missing required property '${req}'`);
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) validate(props[k], v, `${pathStr}.${k}`, out);
      else if (schema.additionalProperties === false) out.push(`${pathStr}: additional property '${k}' not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") validate(schema.additionalProperties, v, `${pathStr}.${k}`, out);
    }
  }
}

function validateAgainst(schema, value) { const out = []; validate(schema, value, "$", out); return out; }

// ---- Cross-registry invariants (pure functions, single source of truth) --
// Each takes a resolved input object and returns an array of error strings
// (empty = pass). The live registry checks and the invariant fixtures both
// call these, so the derivations cannot drift.
const INTERNAL_LOCATOR_KINDS = new Set(["cp-source", "dp-source", "redisinc-source", "cp-unit-test"]);
const MUTATING_COHORT_KINDS = new Set(["mutating-crud", "mutating-module", "background-load"]);
const INVARIANTS = {
  // 1. Scenarios grounded in internal (CP/DP/RedisInc/CP-unit-test) facts must carry an internal-content-leak canary.
  "internal-leak-required": (i) =>
    i.hasInternalFact && !i.hasInternalLeakCanary ? ["scenario resolves internal-locator facts but has no internal-content-leak canary"] : [],
  // 2. A contested block and a top-level authority:"contested" must coexist (both directions).
  "contested-authority": (i) => {
    const e = [];
    if (i.hasContestedBlock && i.authority !== "contested") e.push("contested block requires authority 'contested'");
    if (!i.hasContestedBlock && i.authority === "contested") e.push("authority 'contested' requires a contested block");
    return e;
  },
  // 2b. Scenario authority must be 'contested' iff it references a contested fact.
  "scenario-contested-authority": (i) => {
    const e = [];
    if (i.referencesContestedFact && i.authority !== "contested") e.push("scenario references a contested fact but authority is not 'contested'");
    if (!i.referencesContestedFact && i.authority === "contested") e.push("scenario authority 'contested' but no referenced fact is contested");
    return e;
  },
  // 3. grader must_trigger_criteria must exist in the referenced scenario's correctness rubric.
  "grader-criteria-exist": (i) =>
    (i.must || []).filter((c) => !(i.rubricCriteria || []).includes(c)).map((c) => `must_trigger_criteria '${c}' not a criterion of correctness rubric`),
  // 4. Every embedded defect source_fact_ref must be in the scenario's source_facts.
  "defect-fact-in-scope": (i) =>
    (i.defectRefs || []).filter((r) => !(i.sourceFacts || []).includes(r)).map((r) => `embedded defect fact '${r}' not in scenario source_facts`),
  // 5. Mutating cohort or destructive probe requires the cleanup safety class.
  "cleanup-required": (i) =>
    i.usesMutatingOrDestructive && !i.hasCleanupSafety ? ["scenario uses a mutating cohort or destructive probe but omits saf-shared-cleanup-reuse"] : [],
  // 6a. Probe isolation must match its cohort's isolation.
  "probe-cohort-isolation": (i) =>
    i.probeIsolation && i.cohortIsolation && i.probeIsolation !== i.cohortIsolation
      ? [`probe isolation '${i.probeIsolation}' does not match cohort isolation '${i.cohortIsolation}'`] : [],
  // 6b. A mutating cohort can never be read-only; without namespace injection it must be exclusive.
  "mutating-not-read-only": (i) => {
    const e = [];
    if (!MUTATING_COHORT_KINDS.has(i.cohortKind)) return e;
    if (i.isolation === "read-only") e.push("mutating cohort cannot be read-only");
    if (i.namespaceInjection === false && i.isolation !== "exclusive") e.push("mutating cohort without namespace injection must be exclusive");
    return e;
  },
  // 7. Every probe cohort_ref must be declared in the scenario's probe_cohorts (no under-declaration).
  "no-under-declared-cohort": (i) =>
    (i.probeCohortRefs || []).filter((c) => !(i.declaredCohorts || []).includes(c)).map((c) => `probe cohort '${c}' not declared in scenario probe_cohorts`),
  // 8. A scenario grounded in a live-probe-resolved fact (e.g. NoCluster SELECT) must declare a live probe for evidence.
  "live-fact-requires-probe": (i) =>
    i.referencesLiveProbeFact && !i.hasLiveProbe ? ["scenario references a live-probe-resolved fact but declares no live_probes for evidence"] : []
};


// ---- Load schemas ------------------------------------------------------
const schema = {};
for (const f of fs.readdirSync(schemasDir)) {
  if (f.endsWith(".schema.json")) schema[f.replace(".schema.json", "")] = readJson(path.join(schemasDir, f));
}

// ---- Load catalogs -----------------------------------------------------
const registry = readJson(path.join(registryDir, "registry.json"));
if (registry) {
  const regErrs = validateAgainst(schema["registry"], registry);
  regErrs.forEach((e) => fail("registry.json", e));
}

const catalogFiles = {
  "safety-class": "safety-classes.json",
  "cache-requirement": "cache-requirements.json",
  "rubric": "rubrics.json",
  "source-fact": "source-facts.json",
  "source-provider-locator": "source-provider-locators.json",
  "live-probe": "live-probes.json",
  "baseline-leakage-canary": "baseline-leakage-canaries.json",
  "grader-canary": "grader-canaries.json",
  "mutation-selection": "mutation-selections.json",
  "acceptance-thresholds": "acceptance-thresholds.json",
  "probe-cohort": "probe-cohorts.json"
};

const ids = { saf: new Set(), cch: new Set(), rub: new Set(), src: new Set(), loc: new Set(), prb: new Set(), blc: new Set(), grc: new Set(), mut: new Set(), acc: new Set(), coh: new Set(), scn: new Set() };
const idOf = { "safety-class": "saf", "cache-requirement": "cch", "rubric": "rub", "source-fact": "src", "source-provider-locator": "loc", "live-probe": "prb", "baseline-leakage-canary": "blc", "grader-canary": "grc", "mutation-selection": "mut", "acceptance-thresholds": "acc", "probe-cohort": "coh" };
const rubricKind = {};
const factById = {};

for (const [schemaKey, file] of Object.entries(catalogFiles)) {
  const data = readJson(path.join(registryDir, file));
  if (!Array.isArray(data)) { fail(file, "expected a JSON array"); continue; }
  const prefix = idOf[schemaKey];
  data.forEach((item, i) => {
    const errs = validateAgainst(schema[schemaKey], item);
    errs.forEach((e) => fail(`${file}[${i}] (${item && item.id})`, e));
    if (item && item.id) {
      const bucket = ids[item.id.split("-")[0]];
      if (bucket) bucket.add(item.id);
      if (schemaKey === "rubric") rubricKind[item.id] = item.kind;
      if (schemaKey === "source-fact") factById[item.id] = item;
    }
  });
}

// ---- Load scenarios ----------------------------------------------------
const scenarios = [];
if (registry && Array.isArray(registry.scenarios)) {
  for (const entry of registry.scenarios) {
    const file = path.join(registryDir, entry.file);
    const scn = readJson(file);
    if (!scn) continue;
    scenarios.push({ entry, scn, file });
    const errs = validateAgainst(schema["scenario"], scn);
    errs.forEach((e) => fail(entry.file, e));
    if (scn.id) ids.scn.add(scn.id);
    if (scn.id !== entry.id) fail(entry.file, `id '${scn.id}' does not match registry entry '${entry.id}'`);
  }
}

// ---- Referential integrity --------------------------------------------
function ref(bucket, id, where, kind) {
  if (id && !ids[bucket].has(id)) fail(where, `unresolved ${kind} reference '${id}'`);
}
for (const { scn, entry } of scenarios) {
  const w = entry.file;
  (scn.safety_classes || []).forEach((x) => ref("saf", x, w, "safety-class"));
  (scn.cache_requirements || []).forEach((x) => ref("cch", x, w, "cache-requirement"));
  (scn.source_facts || []).forEach((x) => ref("src", x, w, "source-fact"));
  (scn.live_probes || []).forEach((x) => ref("prb", x, w, "live-probe"));
  (scn.probe_cohorts || []).forEach((x) => ref("coh", x, w, "probe-cohort"));
  (scn.baseline_leakage_canaries || []).forEach((x) => ref("blc", x, w, "baseline-leakage-canary"));
  (scn.grader_canaries || []).forEach((x) => ref("grc", x, w, "grader-canary"));
  ref("rub", scn.correctness_rubric_ref, w, "rubric");
  ref("rub", scn.actionability_rubric_ref, w, "rubric");
  ref("mut", scn.mutation_selection_ref, w, "mutation-selection");
  ref("acc", scn.acceptance_ref, w, "acceptance-thresholds");
  if (scn.correctness_rubric_ref && rubricKind[scn.correctness_rubric_ref] && rubricKind[scn.correctness_rubric_ref] !== "correctness")
    fail(w, `correctness_rubric_ref '${scn.correctness_rubric_ref}' is not a correctness rubric`);
  if (scn.actionability_rubric_ref && rubricKind[scn.actionability_rubric_ref] && rubricKind[scn.actionability_rubric_ref] !== "actionability")
    fail(w, `actionability_rubric_ref '${scn.actionability_rubric_ref}' is not an actionability rubric`);
  for (const art of scn.input_artifacts || [])
    for (const d of art.embedded_defects || [])
      ref("src", d.source_fact_ref, w, "source-fact(defect)");
}

// rubric criteria -> source facts; source facts -> locators; contested-authority invariant
const rubricsData = readJson(path.join(registryDir, catalogFiles["rubric"])) || [];
const rubricCriteriaById = {};
for (const r of rubricsData) {
  rubricCriteriaById[r.id] = (r.criteria || []).map((c) => c.id);
  for (const c of r.criteria || []) if (c.source_fact_ref) ref("src", c.source_fact_ref, `${catalogFiles["rubric"]} (${r.id})`, "source-fact");
}
const locatorKindById = {};
for (const l of readJson(path.join(registryDir, catalogFiles["source-provider-locator"])) || []) locatorKindById[l.id] = l.provider_kind;
function inv(name, input, where) { for (const e of INVARIANTS[name](input)) fail(where, `[${name}] ${e}`); }
for (const [id, f] of Object.entries(factById)) {
  ref("loc", f.locator_ref, `source-facts.json (${id})`, "source-provider-locator");
  inv("contested-authority", { hasContestedBlock: !!f.contested, authority: f.authority }, `source-facts.json (${id})`);
}
const canaryData = readJson(path.join(registryDir, catalogFiles["grader-canary"])) || [];
const scnById = {};
for (const { scn } of scenarios) scnById[scn.id] = scn;
for (const g of canaryData) {
  ref("scn", g.scenario_ref, `grader-canaries.json (${g.id})`, "scenario");
  (g.must_trigger_safety || []).forEach((x) => ref("saf", x, `grader-canaries.json (${g.id})`, "safety-class"));
  const targetScn = scnById[g.scenario_ref];
  if (targetScn && g.must_trigger_criteria)
    inv("grader-criteria-exist", { must: g.must_trigger_criteria, rubricCriteria: rubricCriteriaById[targetScn.correctness_rubric_ref] || [] }, `grader-canaries.json (${g.id})`);
}
const blcData = readJson(path.join(registryDir, catalogFiles["baseline-leakage-canary"])) || [];
for (const b of blcData) ref("scn", b.scenario_ref, `baseline-leakage-canaries.json (${b.id})`, "scenario");
const mutData = readJson(path.join(registryDir, catalogFiles["mutation-selection"])) || [];
for (const m of mutData) ref("scn", m.scenario_ref, `mutation-selections.json (${m.id})`, "scenario");

// live-probe cohort refs + destructive/isolation coherence
const probeData = readJson(path.join(registryDir, catalogFiles["live-probe"])) || [];
const probeById = {};
for (const p of probeData) {
  probeById[p.id] = p;
  if (p.cohort_ref) ref("coh", p.cohort_ref, `live-probes.json (${p.id})`, "probe-cohort");
  if (p.destructive === true && p.isolation === "read-only") fail(`live-probes.json (${p.id})`, "destructive probe cannot have read-only isolation");
}

// probe-cohort semantic rules: locator ref, mutating classification, cleanup rejection, probe/cohort isolation
const cohData = readJson(path.join(registryDir, catalogFiles["probe-cohort"])) || [];
const cohortById = {};
for (const c of cohData) {
  cohortById[c.id] = c;
  ref("loc", c.runtime_config && c.runtime_config.locator_ref, `probe-cohorts.json (${c.id})`, "source-provider-locator");
  inv("mutating-not-read-only", { cohortKind: c.cohort_kind, isolation: c.isolation, namespaceInjection: c.namespace_injection }, `probe-cohorts.json (${c.id})`);
  if (MUTATING_COHORT_KINDS.has(c.cohort_kind) && c.namespace_injection === false && (!c.lease || c.lease.required !== true || c.lease.mode !== "exclusive"))
    fail(`probe-cohorts.json (${c.id})`, "mutating cohort without namespace injection must require an exclusive lease");
  if (c.cleanup && c.cleanup.forbid_subscription_wide_cleanup !== true) fail(`probe-cohorts.json (${c.id})`, "cohort must forbid subscription-wide cleanup reuse");
}
for (const p of probeData) {
  if (p.cohort_ref && cohortById[p.cohort_ref])
    inv("probe-cohort-isolation", { probeIsolation: p.isolation, cohortIsolation: cohortById[p.cohort_ref].isolation }, `live-probes.json (${p.id})`);
}

// scenario-level invariants (internal-leak, contested authority, defect scope, cleanup, no under-declared cohort)
for (const { scn, entry } of scenarios) {
  const w = entry.file;
  const facts = (scn.source_facts || []).map((id) => factById[id]).filter(Boolean);
  const hasInternalFact = facts.some((f) => INTERNAL_LOCATOR_KINDS.has(locatorKindById[f.locator_ref]));
  const hasInternalLeakCanary = (scn.baseline_leakage_canaries || [])
    .map((id) => (blcData.find((b) => b.id === id) || {}).canary_kind)
    .includes("internal-content-leak");
  inv("internal-leak-required", { hasInternalFact, hasInternalLeakCanary }, w);

  const referencesContestedFact = facts.some((f) => !!f.contested);
  inv("scenario-contested-authority", { referencesContestedFact, authority: scn.authority }, w);

  const referencesLiveProbeFact = facts.some((f) => locatorKindById[f.locator_ref] === "live-probe");
  inv("live-fact-requires-probe", { referencesLiveProbeFact, hasLiveProbe: (scn.live_probes || []).length > 0 }, w);

  const defectRefs = [];
  for (const art of scn.input_artifacts || []) for (const d of art.embedded_defects || []) defectRefs.push(d.source_fact_ref);
  inv("defect-fact-in-scope", { defectRefs, sourceFacts: scn.source_facts || [] }, w);

  const cohortKinds = (scn.probe_cohorts || []).map((id) => (cohortById[id] || {}).cohort_kind);
  const usesMutatingCohort = cohortKinds.some((k) => MUTATING_COHORT_KINDS.has(k));
  const usesDestructiveProbe = (scn.live_probes || []).some((id) => (probeById[id] || {}).destructive === true);
  inv("cleanup-required", { usesMutatingOrDestructive: usesMutatingCohort || usesDestructiveProbe, hasCleanupSafety: (scn.safety_classes || []).includes("saf-shared-cleanup-reuse") }, w);

  const probeCohortRefs = (scn.live_probes || []).map((id) => (probeById[id] || {}).cohort_ref).filter(Boolean);
  inv("no-under-declared-cohort", { probeCohortRefs, declaredCohorts: scn.probe_cohorts || [] }, w);
}

// ---- Fixtures ----------------------------------------------------------
let fixtureCount = 0;
const fixtureManifest = readJson(path.join(fixturesDir, "fixtures.manifest.json"));
if (fixtureManifest && Array.isArray(fixtureManifest.fixtures)) {
  for (const fx of fixtureManifest.fixtures) {
    fixtureCount++;
    const fxFile = path.join(fixturesDir, fx.file);
    const data = readJson(fxFile);
    const s = schema[fx.schema];
    if (!s) { fail(`fixtures/${fx.file}`, `unknown schema '${fx.schema}'`); continue; }
    if (data === undefined) continue;
    const errs = validateAgainst(s, data);
    const isValid = errs.length === 0;
    if (fx.expect === "valid" && !isValid) fail(`fixtures/${fx.file}`, `expected valid but failed: ${errs[0]}`);
    if (fx.expect === "invalid" && isValid) fail(`fixtures/${fx.file}`, `expected invalid but passed schema '${fx.schema}'`);
    if (fx.expect === "invalid" && !isValid) notes.push(`fixtures/${fx.file}: correctly rejected (${errs[0]})`);
  }
}

// ---- Invariant fixtures ------------------------------------------------
let invariantFixtureCount = 0;
const invDir = path.join(fixturesDir, "invariants");
if (fs.existsSync(invDir)) {
  for (const f of fs.readdirSync(invDir).filter((x) => x.endsWith(".json"))) {
    invariantFixtureCount++;
    const c = readJson(path.join(invDir, f));
    if (!c) continue;
    if (!INVARIANTS[c.invariant]) { fail(`fixtures/invariants/${f}`, `unknown invariant '${c.invariant}'`); continue; }
    const errs = INVARIANTS[c.invariant](c.input);
    const passed = errs.length === 0;
    if (c.expect === "pass" && !passed) fail(`fixtures/invariants/${f}`, `expected pass but invariant '${c.invariant}' reported: ${errs[0]}`);
    if (c.expect === "fail" && passed) fail(`fixtures/invariants/${f}`, `expected fail but invariant '${c.invariant}' passed`);
    if (c.expect === "fail" && !passed) notes.push(`fixtures/invariants/${f}: invariant '${c.invariant}' correctly reported (${errs[0]})`);
  }
}

// ---- Report ------------------------------------------------------------
const scenarioCount = scenarios.length;
console.log(`soak validator: ${scenarioCount} scenarios, ${Object.values(ids).reduce((a, s) => a + s.size, 0) - ids.scn.size} catalog ids, ${fixtureCount} schema fixtures, ${invariantFixtureCount} invariant fixtures`);
if (notes.length) { console.log("\nExpected-invalid fixtures rejected as designed:"); for (const n of notes) console.log("  - " + n); }
if (errors.length) {
  console.error(`\nFAILED with ${errors.length} error(s):`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log("\nOK: all schema, referential-integrity, and fixture checks passed.");
