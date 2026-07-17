# Retained Artifact Contract

Each evaluation run is an immutable, self-contained record under
[`eval-runs/`](eval-runs/). The corpus itself contains no real endpoint,
credential, subscription, internal source reference, dependency directory, or
build output.

## Required retained tree

```text
eval-runs/
  <run-id>/
    run-manifest.json
    reference-good/                 # exact source tree evaluated
    bad/                            # source tree after listed mutation patches
    with-skill/
      transcript.md
      build-result.json
      live-result.json              # optional; present only for authorized live runs
    without-skill/
      transcript.md
      build-result.json
      live-result.json              # optional; present only for authorized live runs
    patches/
      <mutation-id>.patch
    hashes.json
    reproduce.ps1
    reports/
      report.md
      index.json
```

The `reference-good`, `bad`, `with-skill`, and `without-skill` directories are
not interchangeable. A result is invalid if it lacks any one of them.

## Required links and hashes

`run-manifest.json` must name the source revision, client language, scenario,
mode, selected mutation IDs, and the relative paths to all retained artifacts.
`hashes.json` must contain SHA-256 values for every source file, patch,
transcript, result, and reproduction script. A report in the run-local
`reports/` directory must link to its run manifest, both transcripts, both
result files, the reference-good and bad trees, every patch, and `hashes.json`.

Use only relative paths from the run directory. Never store a real endpoint,
credential, access token, subscription identifier, tenant identifier, or
internal source URL in a manifest, transcript, result, hash file, or report.
Redact environment values before writing transcripts.

## Reproduction

`reproduce.ps1` must be non-interactive and must:

1. Verify `hashes.json`.
2. Apply the retained patches to a copy of `reference-good`.
3. Run the same offline build/check commands for both comparison trees.
4. Write JSON results to `with-skill/build-result.json` and
   `without-skill/build-result.json`.

The `mutations/reference-good` fixture is a dependency-free executable input
for patch verification. Every selected patch must apply to that tree and the
fixture must be run before and after patching; this proves the retained `bad`
tree is executable rather than a descriptive-only artifact.

Live runs are optional and only allowed when the operator supplies credentials
outside the repository. The script must not echo environment variables and must
write a redacted `live-result.json` that conforms to
[`contract.schema.json`](contract.schema.json).

## Exclusions

Do not retain `node_modules`, virtual environments, Cargo targets, `bin`,
`obj`, test caches, package archives, lock files containing private feeds,
source checkouts, telemetry dumps, or screenshots that expose configuration.
The repository `.gitignore` already excludes top-level `eval-runs`; this
corpus keeps the contract in source control and expects actual run data to be
retained by the evaluation workspace.
