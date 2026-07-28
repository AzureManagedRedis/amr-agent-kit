---
name: redis-code
description: |
  Redis coding best practices for Azure Managed Redis. Use when writing,
  reviewing, or refactoring Redis application code, caching, session storage,
  queues, pub/sub, streams, data structures, key design, connection handling,
  vector search, RAG, semantic caching, LLM memory, embeddings, or AI agent
  state on Azure Managed Redis.
  Do NOT use for: Azure Managed Redis infrastructure provisioning, Private Link,
  SKU selection, high availability, geo-replication, persistence, diagnostics,
  or Azure resources unrelated to Redis application code.
license: MIT
metadata:
  author: Microsoft
  version: "1.0.0"
---

# Redis Code Best Practices

Coding patterns and best practices for building Redis-backed applications and AI workloads on Azure Managed Redis. This skill combines general Redis application guidance with vector search, RAG, semantic caching, LLM memory, and agent-state patterns so the model has one code-focused routing target.

## Scope

- Writing or reviewing Redis client code
- Choosing data structures and key naming conventions
- Implementing caching, sessions, queues, leaderboards, locks, rate limits, Pub/Sub, Streams, JSON, and Search
- Configuring TLS, Entra-aware authentication, connection pooling, timeouts, and bounded retries in application code
- Building Redis vector search, RAG, semantic cache, embedding ingestion, LLM memory, and AI agent workflows
- Tuning Redis code paths for latency, memory, and cost

## Agent Guidance

### Critical AMR Guardrails (open the linked rule before answering)

These are the highest-harm facts to get right. When a task touches one, open the linked rule file for the full example rather than relying on memory or a single scan of `AGENTS.md`.

- **Logical databases are topology-dependent.** Clustered (`OSSCluster`/`EnterpriseCluster`) and active geo-replicated caches use database 0 only; `NoCluster` may allow more but must be verified from effective config or a live `SELECT` — never inferred from the managed `default` resource. → `rules/key-use-colons-for-namespacing.md`
- **Multi-key safety is policy-specific.** `OSSCluster` needs same-slot (hash tags) for every multi-key command, transaction, and Lua script; `EnterpriseCluster` can scatter-gather selected non-atomic commands but not transactions, Lua-with-KEYS, or destination-key commands; `NoCluster` is unsharded. → `rules/key-use-hash-tags-for-cluster.md`
- **Use the service-returned endpoint and port.** `10000` is the default database port, not a universal constant; do not reject a valid non-default port or hardcode public-cloud DNS. → `rules/conn-require-tls-amr-endpoints.md`
- **Match modules to cluster policy.** Search (RediSearch) is incompatible with `OSSCluster` and needs `EnterpriseCluster` or a supported `NoCluster` size; RedisJSON is allowed with `OSSCluster`; active geo-replication supports only Search and JSON. → `rules/search-use-enterprise-policy-for-modules.md`
- **Memory is service-managed.** Do not `CONFIG SET maxmemory` from a client; choose SKU and eviction policy in Azure and monitor effective memory. → `rules/memory-monitor-and-set-limits.md`

### Keep Code and Infrastructure Boundaries Clear

Use this skill for code-level decisions: clients, keys, commands, indexes, retrieval logic, cache policy, ingestion flows, and agent state. Use `azure-redis-infra` when the task is about provisioning, SKUs, Private Link, cluster policy, persistence, HA, geo-replication, diagnostics, or Azure resource configuration.

### Apply Critical Rules First

Start with data structures, key design, vector index schema, and tenant/security boundaries. Incorrect structures, unbounded keys, logical-database (`SELECT`/`db=N`) tenancy that does not port across AMR topologies, unsafe cluster key placement, mismatched embedding dimensions, or missing RAG access controls usually require design changes before smaller command-level optimizations matter.

### Prefer AMR-Safe Code Defaults

When generating Redis client code for Azure Managed Redis, default to TLS-enabled endpoints, explicit timeouts, bounded retries with jitter, connection pooling or multiplexing, key TTLs, Microsoft Entra authentication where appropriate, and deterministic ingestion/reindexing workflows.

For production application code, surface the AMR client checklist near the client setup: read the service-returned host name and port from deployment configuration, enable TLS or `rediss://`, keep certificate validation on, prefer Microsoft Entra or managed identity where supported, validate required configuration at startup, reuse a singleton/pool/multiplexer, set connect/socket/command timeouts, use bounded jittered retries, refresh Entra tokens before expiry, and log/measure authentication failures, token-refresh events, connection failures, and Redis latency. In public Azure the default AMR endpoint resembles `<cache-name>.<region>.redis.azure.net` and the default database port is `10000`, but custom database ports and cloud-specific DNS suffixes are supported; do not replace the service-returned values with Azure Cache for Redis defaults such as port `6380`.

Prefer explicit key prefixes over Redis logical databases (`SELECT`/`db=N`) for tenants, environments, and tests. Logical-database availability is topology-dependent on Azure Managed Redis: clustered (`OSSCluster`, `EnterpriseCluster`) and active-geo-replicated (CRDB) caches are engine-constrained to database 0, while a non-clustered (`NoCluster`) cache can permit more than one database. Do not assume AMR is universally single-database or infer the database count from the managed database resource; verify effective config or probe with a live `SELECT` before using any database other than 0. Refactor DB-index tenancy to explicit key prefixes, tenant-aware metadata filters, scoped data access policies/key patterns, and separate AMR caches for hard tenant isolation.

For logical-database, `SELECT`, cluster-policy, multi-key command, transaction, or Lua reviews, make the guidance policy- and topology-specific: `NoCluster` is unsharded (no slot constraint); `OSSCluster` requires same-slot placement (hash tags) for every multi-key command, transaction, and Lua script; `EnterpriseCluster` can scatter-gather selected non-atomic multi-key commands (MGET/MSET/DEL/UNLINK/EXISTS/TOUCH) across slots, but transactions, Lua scripts that declare keys in `KEYS`, and destination-key commands still need co-located keys. Hash tags are the portable co-location mechanism, not a universal requirement for every Enterprise non-atomic command. For logical separation prefer database 0 with key prefixes, and treat DB0-only as engine-proven for clustered and geo-replicated topologies but verify it for `NoCluster`. Include AMR client basics: service-returned host and port, TLS with certificate validation, and a reusable singleton/pool/multiplexer.

### Keep Module and Cluster-Policy Claims Exact

Do not group Search and RedisJSON under one cluster-policy rule. The Search module is incompatible with `OSSCluster`; use `EnterpriseCluster` or a supported `NoCluster` size for search or vector workloads. RedisJSON is permitted with `OSSCluster`. Active geo-replication supports only the Search and JSON modules. Before provisioning, validate the complete SKU, policy, module, region, preview or subscription-allowlist status, flash restrictions, and geo combination.

### Choose the Correct Code Path

| User Intent | Signal Phrases | Primary Categories |
|---|---|---|
| Model application data | "data structure", "schema", "hash", "set", "leaderboard", "counter" | Data Structures, Key Design |
| Improve Redis code performance | "slow", "latency", "round trips", "bulk", "batch" | Commands & Patterns, Connection Management, AI Performance & Cost |
| Implement caching | "cache", "TTL", "stale", "stampede", "semantic cache" | Caching Strategies, Semantic Caching, Key Design |
| Build app primitives | "sessions", "rate limit", "lock", "queue", "stream" | Common Use Cases, Pub/Sub & Streams |
| Build AI workflows | "vector", "embedding", "RAG", "retrieval", "agent memory" | Vector Index Design, Search Query Patterns, RAG, LLM Memory, AI Agent State |
| Harden production code | "retry", "timeout", "health", "memory", "resilience" | Connection Management, Memory Optimization, Error Handling & Resilience |

## Available Resources

- `AGENTS.md` - Full compiled guidance with expanded rules, examples, and references.
- `rules/` - Individual rule files for targeted guidance.
- `rules/_sections.md` - Category ordering, impact, and descriptions.
- `metadata.json` - Version, abstract, and reference links.

## Redis Code Workflow

1. Identify the Redis workload: application data, cache, messaging, search, RAG, memory, or agent state.
2. Select the smallest correct Redis structure and define logical key-prefix boundaries (preferring database 0 for portability), key names, TTLs, size bounds, and policy-appropriate cluster hash tags.
3. Configure AMR-safe client behavior: TLS, authentication, pooling, timeouts, retries, and health checks.
4. For AI workloads, define embedding model, dimensions, distance metric, index schema, metadata filters, and source/tenant boundaries.
5. Batch or pipeline hot paths and ingestion flows while preserving idempotency and replay safety.
6. Add observability hooks, degradation behavior, and tests around stale data, retries, and recovery.

## Rule Categories by Priority

| Priority | Category | Impact | Prefix |
|----------|----------|--------|--------|
| 1 | Data Structures | CRITICAL | `ds-` |
| 2 | Key Design | CRITICAL | `key-` |
| 3 | Commands & Patterns | HIGH | `cmd-` |
| 4 | Connection Management | HIGH | `conn-` |
| 5 | Caching Strategies | HIGH | `cache-` |
| 6 | Common Use Cases | MEDIUM-HIGH | `use-` |
| 7 | Pub/Sub & Streams | MEDIUM | `msg-` |
| 8 | JSON & Search | MEDIUM | `stack-` |
| 9 | Memory Optimization | MEDIUM | `memory-` |
| 10 | Error Handling & Resilience | LOW-MEDIUM | `resilience-` |
| 11 | Vector Index Design | CRITICAL | `vec-` |
| 12 | Search Query Patterns | HIGH | `search-` |
| 13 | Retrieval-Augmented Generation | HIGH | `rag-` |
| 14 | Semantic Caching | HIGH | `semcache-` |
| 15 | LLM Memory | MEDIUM-HIGH | `llm-` |
| 16 | AI Agent State | MEDIUM-HIGH | `agent-` |
| 17 | Embedding Pipelines | MEDIUM | `embed-` |
| 18 | Framework Integration | MEDIUM | `integrate-` |
| 19 | AI Performance & Cost | MEDIUM | `perf-` |

## Quick Reference

### Application Code

- `ds-*` - Choose Redis data structures for hashes, sets, sorted sets, lists, counters, and cardinality.
- `key-*` - Design namespaced, TTL-bound, cluster-safe keys and avoid production `KEYS`.
- `cmd-*` - Use pipelining, transactions, Lua, and batch operations safely.
- `conn-*` - Configure TLS, pooling, timeouts, Entra authentication, and token refresh.
- `cache-*` - Implement cache-aside and stampede prevention.
- `use-*` - Build sessions, rate limiting, and distributed locks.
- `msg-*` - Choose Pub/Sub for ephemeral fan-out, Streams for reliable messaging, and Azure Event Grid/Service Bus integration for cache invalidation workflows.
- `stack-*` - Use RedisJSON and Redis Search for document and query workloads.
- `memory-*` - Optimize encodings, maxmemory policies, and fragmentation.
- `resilience-*` - Add bounded retries, health checks, and production-safe failure handling.

### AI Application Code

- `vec-*` - Store vectors with metadata and align dimensions and distance metrics.
- `search-*` - Match Search/JSON to the cluster policy, then combine vector search with metadata filters and limit returned fields.
- `rag-*` - Preserve citations, chunk deterministically, and enforce tenant/ACL boundaries.
- `semcache-*` - Version semantic cache keys and tune thresholds, TTLs, and invalidation.
- `llm-*` - Bound conversation memory with TTLs and summarization.
- `agent-*` - Persist agent state with idempotent checkpoints and streams.
- `embed-*` - Batch embedding upserts and make ingestion idempotent.
- `integrate-*` - Configure RedisVL and Microsoft Agent Framework with explicit AMR settings.
- `perf-*` - Size vector workloads and tune ingestion/query parameters.

## How to Use the Rule Files

Read individual rule files for detailed explanations and examples:

```text
rules/ds-use-hashes-for-objects.md
rules/key-use-colons-for-namespacing.md
rules/vec-align-dimensions-and-distance-metric.md
rules/rag-enforce-tenant-and-acl-boundaries.md
```

Each rule file contains:
- Brief explanation of why it matters
- Incorrect code example with explanation
- Correct code example with explanation
- Additional context and references

## Full Compiled Document

For the complete guide with all rules expanded, use `AGENTS.md`.
