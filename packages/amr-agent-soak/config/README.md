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
content-hashed into the immutable run snapshot.

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
2. `integration.liveCache.adapterModule` points to a local module exporting
   `createLocalRpAdapter`.

The committed cache adapter currently models the safety contract with a simplified
fake-RP route shape. It is **not** the ARM-shaped local RP adapter required for a
real cache smoke. Do not enable live mode until an adapter implementing the real
subscription/resource-group/database paths has been added and independently reviewed.

When live mode is enabled, `scripts/start-soak.ps1` launches a third, independent
resource janitor and records its verified process identity beside the controller and
process-tree janitor.
