# AMR Agent Kit Soak Suite — Source-Oracle Schema and Scenario Registry

This directory holds a **public-safe** "source oracle" for soak-testing the AMR Agent Kit
skills. It is dependency-free: every artifact is plain JSON validated by a Node script that
uses only the standard library. Nothing here installs packages, and nothing here contains
proprietary control-plane (CP), data-plane (DP), or Redis Inc engine source, internal
paths/symbols/lines, subscriptions, endpoints, or effective configuration.

```
evals/soak/
  schemas/     JSON Schema (draft 2020-12), self-contained, no cross-file $ref
  registry/    shared catalogs + per-scenario manifests + registry.json index
  fixtures/    valid/ and invalid/ fixtures + fixtures.manifest.json
  tools/       validate.mjs (pure Node validator: schema + referential integrity + fixtures)
  README.md
```

Run the validator:

```bash
node evals/soak/tools/validate.mjs
```

It validates every catalog item and scenario against its schema, checks referential
integrity across all id-references, and asserts each fixture passes or fails exactly as
declared. Exit code `0` means the whole registry is consistent.

## Correctness vs. efficacy — two separate things

- **Correctness (this suite).** Does the answer match an authoritative *source fact*? Every
  correctness criterion in a rubric is anchored to a `src-*` fact whose authority is named
  explicitly. Correctness is graded on its own gate and does **not** depend on comparing to a
  baseline.
- **Efficacy (existing `evals/efficacy`).** Does loading a skill *improve* an answer versus no
  skill? Those paired prompts remain **regression-only**. This suite does not duplicate them;
  the optional `uplift` block in an acceptance threshold is the only place efficacy is
  referenced, and it is separate from the correctness gate.

The `skill-harm-staleness` scenario is the guardrail linking the two: a skill must never make a
correct baseline worse or assert version-pinned behavior that is now outdated.

## The source oracle

A **source fact** (`registry/source-facts.json`) is a public-safe assertion — its text is safe
to publish. What is *not* committed is the concrete citation that proves it. Instead each fact
points at a **source-provider locator** (`registry/source-provider-locators.json`), a runtime
contract that says *how* a provider resolves the fact to a citation and *where the resolved
citation is written* — always into the gitignored `eval-runs/` tree, never back into a manifest.

```
source fact (public-safe statement)
   └─ locator_ref → source-provider locator (provider_kind + query_shape)
                       └─ citation_sink.destination = "eval-runs" (const)
```

This keeps the committed manifests generic while allowing a runtime that *does* have access to
CP/DP/RedisInc sources, docs, or a live instance to attach the exact proof locally.

### Authority selection

Every fact declares an `authority`: `cp-unit-test`, `dp-behavior`, `redisinc-enterprise`,
`amr-docs`, `redis-oss-docs`, `live-probe`, or `contested`. When two sources disagree, the fact
is marked `contested` and carries a `contested` block that lists the competing claims, names the
**winning authority**, and records the rationale. Examples in this registry:

- **DB0 vs SELECT** (`src-db0-nocluster-select`): the common assumption "AMR is always
  database-0-only" loses to the CP unit test, which distinguishes clustered database-0-only
  behavior from non-clustered multi-database behavior.
- **Multi-key multi-slot** (`src-cluster-mkms-nuance`): the generic OSS-cluster assumption loses
  to what the enterprise data plane actually enforces.
- **SKU sizing** (`src-sku-metric-based`): mapping a legacy SKU label loses to metric-based
  sizing per AMR docs.
- **CRDB consistency** (`src-crdb-active-active`): "strong single-primary" loses to the
  enterprise engine's active-active conflict-free semantics.

### Contested facts, effective config, and live probes

Some facts are only knowable against a real, provisioned instance. A **live probe**
(`registry/live-probes.json`) describes the abstract check (`CLUSTER INFO`, `CONFIG GET
maxmemory-policy`, a CROSSSLOT attempt) and the expected signal. The endpoint, credentials, and
**effective configuration** the probe observes are resolved through the `live-probe` locator into
`eval-runs/` and are never committed. Effective config therefore lives only in ignored run
output; the committed scenario references only the abstract signal.

### API / version pinning

Facts whose truth depends on a surface version set `stability: "version-pinned"` and carry an
`api_version_pin` (`surface`, `version`, `effective_date`). The staleness guardrail compares a
skill's guidance against these pins so an answer that repeats an outdated behavior fails.

## CP-unit-test-backed generic scenarios (geo 5→6, migration 6→7)

Two topology scenarios encode contested control-plane behavior generically:

- **`scn-geo-active-5-6`** — a *pure geo* participant-count transition, denoted `5 → 6` purely as
  a generic marker.
- **`scn-migration-mixed-6-7`** — a *mixed* migration that combines a topology change with a
  version change, denoted `6 → 7` as a generic marker.

For both, the **only** authority for what transition is permitted is the control-plane
validation asserted by a CP **unit test** (`authority: cp-unit-test`,
`cp_unit_test_backed: true`, locator `loc-cp-unit-test`). The committed scenario deliberately
does not state the concrete allowed path — the numbers are opaque markers. At runtime the
provider resolves the actual assertion (test name, exact permitted transition) into `eval-runs/`.
A correct answer defers to that validation instead of assuming any transition is allowed, and
keeps geo/CRDB participants on database-0 semantics.

## Anatomy of a scenario

Defects live inside `input_artifacts`, not in prose — the prompt asks for a review/design and
each embedded defect points at the `src-*` fact it violates. A scenario wires in, by
id-reference:

| Reference | Catalog | Purpose |
|---|---|---|
| `safety_classes` | `safety-classes.json` | Blocking/non-blocking harm classes; a blocking violation fails outright |
| `cache_requirements` | `cache-requirements.json` | Cache-correctness requirements where relevant |
| `source_facts` | `source-facts.json` | Facts the answer must honor |
| `live_probes` | `live-probes.json` | Optional runtime confirmations |
| `correctness_rubric_ref` | `rubrics.json` (kind=correctness) | Fact-anchored scoring |
| `actionability_rubric_ref` | `rubrics.json` (kind=actionability) | Is the answer concretely usable |
| `baseline_leakage_canaries` | `baseline-leakage-canaries.json` | Non-discriminating baseline / internal-leak detectors |
| `grader_canaries` | `grader-canaries.json` | Known-good/known-bad answers that calibrate the grader |
| `mutation_selection_ref` | `mutation-selections.json` | Held-out mutations to guard against overfitting |
| `acceptance_ref` | `acceptance-thresholds.json` | The pass gate |

### Canaries and held-out mutations

- **Baseline-leakage canaries** flag when a scenario stops discriminating (the no-skill baseline
  already emits the correct nuance → `harden`) or when an answer leaks internal content such as a
  source line reference → `reject`.
- **Grader canaries** are synthetic known-good and known-bad answers. Acceptance requires
  known-good to pass and known-bad to fail, which validates the grader itself.
- **Mutation selection** defines held-out perturbations; final acceptance is measured on a
  held-out mutation chosen at runtime from a seed drawn from `eval-runs/`, so the held-out choice
  is not baked into the committed manifest.

### Acceptance gates

`acceptance-thresholds.json` defines named tiers (`acc-standard`, `acc-strict`, `acc-regression`).
A scenario passes only when correctness, actionability, safety (zero blocking violations),
grader-canary, leakage (zero internal leaks), and held-out gates are all satisfied. `uplift` is
the optional, separate efficacy gate.

## Domain coverage (17 scenarios)

routing · connection/auth · stampede · cluster-policy (CROSSSLOT / multi-key multi-slot) ·
DB0 clustered vs contested NoCluster SELECT · Streams/PubSub · memory/OOM · vector/RAG/semantic
cache · workload-based SKU sizing · CP negative validation · HA/persistence/geo · pure geo 5→6 ·
mixed migration 6→7 · lifecycle · networking/identity/observability · CRDB · skill-harm/staleness.

## Security posture

- Committed here: public-safe schemas, scenarios, rubrics, facts (statements only), safety
  classes, cache requirements, canaries, mutations, acceptance thresholds, and runtime
  **locator contracts**.
- Never committed: proprietary CP/DP/RedisInc source, internal paths/symbols/lines,
  subscription ids, endpoints, credentials, or effective config. Those resolve only into the
  already-gitignored `eval-runs/` tree.
- Schemas enforce this where they can: `public_safe` is `const true`, locator/mutation sinks are
  pinned to `eval-runs`, and an `internal-content-leak` canary rejects answers that echo a
  source line reference.
