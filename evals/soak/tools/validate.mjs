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
  "acceptance-thresholds": "acceptance-thresholds.json"
};

const ids = { saf: new Set(), cch: new Set(), rub: new Set(), src: new Set(), loc: new Set(), prb: new Set(), blc: new Set(), grc: new Set(), mut: new Set(), acc: new Set(), scn: new Set() };
const idOf = { "safety-class": "saf", "cache-requirement": "cch", "rubric": "rub", "source-fact": "src", "source-provider-locator": "loc", "live-probe": "prb", "baseline-leakage-canary": "blc", "grader-canary": "grc", "mutation-selection": "mut", "acceptance-thresholds": "acc" };
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

// rubric criteria -> source facts; source facts -> locators; contested -> winning authority present
const rubricsData = readJson(path.join(registryDir, catalogFiles["rubric"])) || [];
for (const r of rubricsData) for (const c of r.criteria || []) if (c.source_fact_ref) ref("src", c.source_fact_ref, `${catalogFiles["rubric"]} (${r.id})`, "source-fact");
for (const [id, f] of Object.entries(factById)) {
  ref("loc", f.locator_ref, `source-facts.json (${id})`, "source-provider-locator");
  if (f.authority === "contested" && !f.contested) fail(`source-facts.json (${id})`, "authority is 'contested' but no contested block present");
}
const canaryData = readJson(path.join(registryDir, catalogFiles["grader-canary"])) || [];
for (const g of canaryData) { ref("scn", g.scenario_ref, `grader-canaries.json (${g.id})`, "scenario"); (g.must_trigger_safety || []).forEach((x) => ref("saf", x, `grader-canaries.json (${g.id})`, "safety-class")); }
const blcData = readJson(path.join(registryDir, catalogFiles["baseline-leakage-canary"])) || [];
for (const b of blcData) ref("scn", b.scenario_ref, `baseline-leakage-canaries.json (${b.id})`, "scenario");
const mutData = readJson(path.join(registryDir, catalogFiles["mutation-selection"])) || [];
for (const m of mutData) ref("scn", m.scenario_ref, `mutation-selections.json (${m.id})`, "scenario");

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

// ---- Report ------------------------------------------------------------
const scenarioCount = scenarios.length;
console.log(`soak validator: ${scenarioCount} scenarios, ${Object.values(ids).reduce((a, s) => a + s.size, 0) - ids.scn.size} catalog ids, ${fixtureCount} fixtures`);
if (notes.length) { console.log("\nExpected-invalid fixtures rejected as designed:"); for (const n of notes) console.log("  - " + n); }
if (errors.length) {
  console.error(`\nFAILED with ${errors.length} error(s):`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log("\nOK: all schema, referential-integrity, and fixture checks passed.");
