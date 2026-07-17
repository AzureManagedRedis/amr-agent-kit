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
| `SOAK_KEY_NAMESPACE` | Live only | Colon-delimited namespace. Every generated key starts with it. Dry-run defaults to `soak:offline`. |
| `REDIS_ENDPOINT` | Live only | TLS endpoint. It is validated but never printed. |
| `SOAK_TIMEOUT_MS` | No | Positive operation deadline; default `750`. |
| `SOAK_MAX_RETRIES` | No | Bounded retries; default `3`. |
| `SOAK_TTL_SECONDS` | No | Positive cache or lock lifetime; default `60`. |

Each executable emits exactly one JSON result to standard output. It deliberately
omits endpoints, credentials, authorization headers, subscription identifiers,
and raw client exceptions. `dry-run` validates the contract and computes a
namespaced probe key without connecting to Redis.

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
restore packages, contact a Redis endpoint, or create build output in the
repository.

## Live integration boundary

The SDK-specific adapters are intentionally isolated from offline execution.
They show the required lifecycle: one retained client/pool, TLS validation,
bounded deadlines and retries, namespaced keys, explicit TTLs, and
machine-readable telemetry. A consumer supplies the named SDK outside this
corpus and retains live results under `eval-runs`; do not vendor dependencies
or generated output here.

Read [artifact-contract.md](artifact-contract.md) before producing an eval run.
