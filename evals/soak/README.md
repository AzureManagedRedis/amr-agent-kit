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
integrity across all id-references, enforces the cross-registry invariants below, and
asserts each schema and invariant fixture passes or fails exactly as declared. Exit code
`0` means the whole registry is consistent.

### Enforced cross-registry invariants

These are implemented as pure functions in `tools/validate.mjs` (a single source of truth
reused by both the live registry checks and the `fixtures/invariants/` cases, so the
derivations cannot silently drift):

1. **`internal-leak-required`** — any scenario whose source facts resolve through an
   internal locator (`cp-source`, `dp-source`, `redisinc-source`, `cp-unit-test`) must
   carry an `internal-content-leak` baseline canary. This is *derived* from each fact's
   locator provider kind, so it stays correct as facts change (covers connection, cluster,
   db0, cp-negative, geo, migration, lifecycle, crdb).
2. **`contested-authority`** / **`scenario-contested-authority`** — a `contested` block and
   a top-level `authority: "contested"` must coexist, both for facts and (via referenced
   facts) for scenarios. The winning authority lives only inside the `contested` block.
3. **`grader-criteria-exist`** — every grader-canary `must_trigger_criteria` id must be a
   real criterion of the referenced scenario's correctness rubric.
4. **`defect-fact-in-scope`** — every embedded-defect `source_fact_ref` must appear in its
   scenario's `source_facts`.
5. **`cleanup-required`** — any scenario that references a mutating cohort or a destructive
   probe must include the `saf-shared-cleanup-reuse` safety class.
6. **`probe-cohort-isolation`** / **`mutating-not-read-only`** — a probe's isolation must
   equal its cohort's isolation, and a mutating cohort can never be `read-only` (regardless
   of namespace injection; without injection it must additionally be exclusive and leased).
7. **`no-under-declared-cohort`** — every cohort a live probe binds must be declared in its
   scenario's `probe_cohorts` (extra declared cohorts are allowed; see over-declaration
   below).
8. **`live-fact-requires-probe`** — a scenario grounded in a fact that resolves through the
   `live-probe` locator (e.g. NoCluster `SELECT` availability) must declare a live probe, so
   the truth is never graded without live/effective-config evidence.
9. **`known-good-covers-required`** — a known-good grader canary must declare
   `must_trigger_criteria` covering every *required* criterion of its scenario's correctness
   rubric, so calibration answers cannot silently drop a required check.
10. **`scenario-canary-coverage`** — every scenario must have at least one known-good and one
    known-bad grader canary so the grader stays calibrated in both directions.

Grader-canary calibration note: a known-good canary's `answer_excerpt` must be written to
unambiguously satisfy *every* required correctness criterion **and** the scenario's
actionability criterion (named keys, concrete TTLs, commands, index schemas, tier sizes, or
staged sequences as applicable) — a real grader must pass it. The invariants above enforce
declared correctness coverage and both-direction canary presence; the actionability concreteness
is enforced by review of the excerpt text.

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

- **NoCluster DB0 vs SELECT** (`src-db0-nocluster-select`): both the blanket "AMR is always
  database-0-only" assumption and a blanket "NoCluster has multiple databases" claim lose to a
  **live SELECT probe / effective configuration**. The control and data planes are silent on the
  database count; a standalone non-clustered engine defaults to multiple databases absent an
  override, but the effective AMR/ACRE behavior is unresolved until probed — so neither extreme is
  graded as verified without evidence. The clustered/CRDB database-0-only rule
  (`src-db0-clustered-single-db`) is separately engine-proven (`redisinc-enterprise`).
- **Cross-slot multi-key** (`src-cluster-crossslot`): policy-parameterized and attributed to the
  Redis Enterprise engine. OSSCluster strictly rejects cross-slot multi-key with CROSSSLOT;
  Enterprise with effective mkms can scatter-gather selected non-atomic commands
  (MGET/MSET/DEL/UNLINK/EXISTS/TOUCH); transactions, Lua-with-KEYS, and STORE commands still need
  one slot; NoCluster is unsharded. Hash tags (`src-cluster-hashtag`) are the portable co-location
  mechanism required for the atomic/transaction/Lua/STORE cases, not for every non-atomic command.
- **Multi-key multi-slot** (`src-cluster-mkms-nuance`): the generic OSS-cluster assumption loses
  to what the enterprise engine actually enforces.
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
skill's guidance against these pins so an answer that repeats an outdated behavior fails. The
pinned `version: "current"` is a deliberate placeholder resolved at runtime through the fact's
locator into `eval-runs/`, keeping the committed manifest generic.

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
| `probe_cohorts` | `probe-cohorts.json` | Runtime execution cohorts (determinism, isolation, leasing) |
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

## Runtime execution cohorts, leasing, and isolation

Findings from the AMR testing repository are encoded as **probe cohorts**
(`registry/probe-cohorts.json`). A cohort classifies how a scenario's probes are
executed against real test infrastructure, and each is referenced from scenarios via
`probe_cohorts` and from probes via `cohort_ref`.

| Cohort | Determinism | Isolation | Lease |
|---|---|---|---|
| `coh-gen2-unit-test` | deterministic | read-only | none |
| `coh-reqnroll-dry-run` | deterministic | read-only | none |
| `coh-readonly-connectivity` | deterministic | read-only | shared, per-run |
| `coh-mutating-crud` | best-effort | exclusive | **exclusive, per-run** |
| `coh-mutating-module` | best-effort | exclusive | **exclusive, per-run** |
| `coh-background-load` | nondeterministic | exclusive | **exclusive, per-run** |

- **Deterministic, side-effect-free cohorts** — Gen2 unit tests and `REQNROLL_DRY_RUN`
  runs — need no lease and can share infrastructure.
- **Read-only connectivity** against an existing cache takes a shared per-run lease.
- **Mutating cohorts** (CRUD, module, background load) are classified **exclusive and
  leased**. The existing tests use fixed keys with **no cross-run lease**, so a mutating
  selector cannot safely share a target. A cohort may only relax to shared/`namespaced`
  isolation when `namespace_injection: true` (the harness injects a per-run key
  namespace). Until then, mutating selectors are exclusive. The validator enforces this:
  a `mutating-*`/`background-load` cohort with `namespace_injection: false` **must** be
  `isolation: exclusive` with an exclusive per-run lease.

**Runtime configuration is public-safe.** Each cohort names an abstract `provider_id`
(e.g. `gen2-e2e-harness`), a `locator_ref` to `loc-testing-harness`, and configuration
**KEY NAMES** only (e.g. `REQNROLL_DRY_RUN`). No testing-repository paths, test names,
subscription ids, lease targets, endpoints, or effective config are committed; those
resolve through the locator into `eval-runs/`.

**Subscription-wide cleanup is rejected.** Every cohort sets
`cleanup.forbid_subscription_wide_cleanup: true` (a schema `const`), and the blocking
safety class `saf-shared-cleanup-reuse` fails any answer or run that reuses a
subscription-wide cleanup job or shares a mutating target without an exclusive lease or
injected namespace. Cleanup must be scoped to the leased target or the injected per-run
namespace.

**Over-declared, runtime-only cohorts.** A scenario's `probe_cohorts` lists every cohort
its runtime may exercise — a *superset* of the cohorts bound by committed live probes. The
validator forbids *under*-declaration (`no-under-declared-cohort`) but intentionally allows
extra cohorts that have no committed probe. Two such runtime-only cohorts are declared on
purpose: the vector scenario's `coh-mutating-module` (the vector index build) and the CRDB
scenario's `coh-background-load` (sustained conflict load). They are real leased, exclusive
activities the runtime performs; their concrete execution resolves through the
`loc-testing-harness` locator into `eval-runs/` rather than through a committed probe.

## Domain coverage (17 scenarios)

routing · connection/auth · stampede · cluster-policy (CROSSSLOT / multi-key multi-slot) ·
DB0 clustered vs contested NoCluster SELECT · Streams/PubSub · memory/OOM · vector/RAG/semantic
cache · workload-based SKU sizing · CP negative validation · HA/persistence/geo · pure geo 5→6 ·
mixed migration 6→7 · lifecycle · networking/identity/observability · CRDB · skill-harm/staleness.

## Security posture

- Committed here: public-safe schemas, scenarios, rubrics, facts (statements only), safety
  classes, cache requirements, canaries, mutations, acceptance thresholds, and runtime
  **locator contracts**.
- Never committed: proprietary CP/DP/RedisInc **or testing-repository** source, internal
  paths/symbols/lines, test names, subscription ids, endpoints, credentials, lease
  targets, or effective config. Those resolve only into the already-gitignored
  `eval-runs/` tree.
- Schemas enforce this where they can: `public_safe` is `const true`, locator/mutation
  and cohort-cleanup sinks are pinned to `eval-runs`/`const true`, cohort config exposes
  key names only, and an `internal-content-leak` canary rejects answers that echo a
  source line reference.

## Integration notes (base / HEAD provenance)

The requested setup step was `git merge --ff-only origin/redis-phil-skill-format-review`
with an expected HEAD of `9aa6250`. That branch had already been merged into `main`
(PR #1), so the fast-forward reported **"Already up to date"** and `9aa6250` is an
**ancestor** of the current HEAD rather than the tip.

Per the containing-HEAD rule, this work proceeded on the containing HEAD without any reset
or history rewrite:

- **Assigned ownership:** `evals/soak/**` only.
- **Branch:** `dmon-dmon-soak-source-oracle` (the `rename_branch` tool prefixes the
  requested `dmon/soak-source-oracle`).
- **Actual base** (`git merge-base HEAD origin/main`): `ec7e450` — the PR #1 merge of
  `redis-phil-skill-format-review` into `main`.
- **`git merge-base --is-ancestor 9aa6250 HEAD`:** true (exit 0) — all expected
  `redis-phil-skill-format-review` content is present.
- **Soak commits (on top of `ec7e450`):** `1d6f5c6` (schema + scenario registry), then
  `5bc9356` (probe-cohort lease/isolation layer).
