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
