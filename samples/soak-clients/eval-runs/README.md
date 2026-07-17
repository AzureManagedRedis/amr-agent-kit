# Evaluation Run Retention

Actual run data belongs under this directory but is ignored by the repository
root. Start from `run-manifest.schema.json` and
[`../artifact-contract.md`](../artifact-contract.md).

For each run, preserve the exact `reference-good` and `bad` trees, both skill
condition outputs, every mutation patch, transcripts with environment values
redacted, build and optional live JSON results, SHA-256 hashes, and the
reproduction command. Add a linked report under `reports/`; do not retain
dependencies or build output.
