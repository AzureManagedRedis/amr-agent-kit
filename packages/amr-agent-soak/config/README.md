# Soak runtime configuration

`soak.config.example.json` is secret-free and runs with live cache access disabled.
Copy it to a `*.local.json` file before use; local configuration files are ignored.

The controller loads `src/integration/runtime.mjs`, which:

- selects scenarios from the validated `evals/soak` registry;
- physically isolates paired skill and baseline workspaces;
- retains bad, reference-good, with-skill, and without-skill trees;
- grades and reports through the existing grading/report modules; and
- writes source, effective-config, and live-probe evidence only under `eval-runs`.

The committed example uses `integration.grading.mode=deterministic-preflight`.
That mode is deliberately limited to at most one hour, two repetitions, and no
live cache access. A 48-hour launch must set `mode=external-blind` and provide a
reviewed, gitignored/local module exporting `createBlindGrader`; the module is
content-hashed into the immutable run snapshot. `createBlindGrader` receives
`runtime`, `evidenceStore`, `config`, and `repositoryRoot`, and returns a
pair grader with:

- `gradePair(artifacts, scenario, pairId)`, returning grades for both
  `with-skill` and `without-skill`; each grade's `details.grading` is the
  adjudicated result and `details.graders` contains both raw grader results; and
- `assertCalibration(scenarios)`, returning `{ passed, modelIds, kappa }`.

Launch fails unless calibration passes, `modelIds` contains at least two distinct
models, and kappa meets `integration.grading.minimumKappa` (default `0.6`).
`blind-grading.example.json` shows the production shape using the committed
Copilot CLI bridge. Both grader model IDs must also differ from the configured
scenario-executor model when `requireExecutorDiversity` is true.

## Evidence hooks

Set `integration.evidence.sourceFile`, `effectiveConfigFile`, or `liveProbeFile` to
gitignored local JSON files. A hook module can instead be listed under
`integration.evidence.hooks` with `id`, `phase`, `kind`, `modulePath`, and optional
`exportName`. Hook output is rejected if it contains local source paths, internal
file/line citations, subscription or tenant identifiers, endpoints, or GUIDs.

## Live cache mode

Live cache mode fails closed unless both are configured:

1. `integration.liveCache.runtimeConfigPath` points to a gitignored file conforming
   to `runtime-config.schema.json`.
2. The reviewed ARM-shaped adapter is used by default from
   `src/cache/http-adapter.mjs`. `integration.liveCache.adapterModule` is optional
   and exists only for an independently reviewed compatible replacement.

The committed adapter uses localhost:8443, ARM subscription/resource-group
`Microsoft.Cache/redisEnterprise` cluster and `databases/default` paths, required
Referer and api-version handling, same-origin polling, and create-only mutation
guards. Live remains disabled until cache-owner review/PID follow-up and the
runtime prerequisites are cleared.
Even with `enabled=true`, both controller and resource janitor reject startup
until `integration.liveCache.reviewedReady=true` is set after that clearance.
`createPollTimeoutMs` and `deletePollTimeoutMs` are explicit bounded overall
deadlines for the multi-minute local-RP operations. ARM list calls follow
same-origin `nextLink` pages with a maximum-page guard.

When live mode is enabled, `scripts/start-soak.ps1` launches a third, independent
resource janitor and records its verified process identity beside the controller and
process-tree janitor.
