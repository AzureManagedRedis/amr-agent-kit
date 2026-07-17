# Retained Multilingual Soak Client Corpus

This corpus is a secret-free evaluation input, not a deployable Redis application.
It provides production-shaped reference-good client seams for five SDKs and
deterministic anti-pattern mutations.

## Common contract

Every client reads the same environment variables:

| Variable | Required | Meaning |
| --- | --- | --- |
| `SOAK_MODE` | No | `dry-run` (default) or `live`. |
| `SOAK_SCENARIO` | No | `cache`, `stream`, `pubsub`, `ingestion`, `semantic-cache`, or `checkpoint`. |
| `SOAK_KEY_NAMESPACE` | No | Colon-delimited namespace prefix. Dry-run defaults to `soak`. |
| `SOAK_RUN_ID` | No | Per-run identifier. Every key and structure includes it; dry-run defaults to `offline`. |
| `REDIS_ENDPOINT` | Live only | TLS endpoint. It is validated but never printed. |
| `SOAK_TIMEOUT_MS` | No | Positive operation deadline; default `750`. |
| `SOAK_MAX_RETRIES` | No | Bounded retries; default `3`. |
| `SOAK_TTL_SECONDS` | No | Positive cache or lock lifetime; default `60`. |

Each executable emits exactly one JSON result to standard output. It deliberately
omits endpoints, credentials, authorization headers, subscription identifiers,
and raw client exceptions. `dry-run` validates the contract and computes a
namespaced probe and teardown keys without connecting to Redis. Keys use
`<namespace>:<run-id>:<scenario>:<purpose>`.

## Layout

```text
dotnet/       StackExchange.Redis seam
python/       redis-py seam
go/           go-redis seam
rust/         redis-rs seam
node/         node-redis seam
mutations/    deterministic bad-pattern patches
eval-runs/    retained evaluation-run contract and schemas
tests/        offline corpus assertions
tools/        no-install validation command
```

## Offline validation

From this directory on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\run-offline-checks.ps1
```

The command runs only dry-run paths and standard library checks. It does not
install external packages or contact a Redis endpoint. It preflights a writable, ignored
`.offline-output` directory under this corpus, directs .NET and Cargo output
there, and removes it after the check.

## Live integration boundary

The SDK-specific adapters are intentionally isolated from offline execution.
They show the required lifecycle: one retained client/pool, TLS validation,
bounded deadlines and retries, namespaced keys, explicit TTLs, and
machine-readable telemetry. A consumer supplies the named SDK outside this
corpus and retains live results under `eval-runs`; do not vendor dependencies
or generated output here.

Every live scenario must delete only its own `teardownKey` and named module
indexes or structures in a `finally`/defer cleanup path. Reference-good code
never uses `FLUSHDB`, `FLUSHALL`, or unscoped `KEYS`; teardown is limited to the
configured namespace, run ID, and scenario.

When a scenario creates a module index or structure, derive its name as
`<namespace>:<run-id>:<scenario>:structure` and use that module's targeted
drop API in the same cleanup path. The structure name and drop result belong in
the retained live result; never replace targeted teardown with a database-wide
flush.

Read [artifact-contract.md](artifact-contract.md) before producing an eval run.
