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

### Keep Code and Infrastructure Boundaries Clear

Use this skill for code-level decisions: clients, keys, commands, indexes, retrieval logic, cache policy, ingestion flows, and agent state. Use `azure-redis-infra` when the task is about provisioning, SKUs, Private Link, cluster policy, persistence, HA, geo-replication, diagnostics, or Azure resource configuration.

### Apply Critical Rules First

Start with data structures, key design, vector index schema, and tenant/security boundaries. Incorrect structures, unbounded keys, SELECT/database-index tenancy on AMR, unsafe cluster key placement, mismatched embedding dimensions, or missing RAG access controls usually require design changes before smaller command-level optimizations matter.

### Prefer AMR-Safe Code Defaults

When generating Redis client code for Azure Managed Redis, default to TLS-enabled endpoints, explicit timeouts, bounded retries with jitter, connection pooling or multiplexing, key TTLs, Microsoft Entra authentication where appropriate, and deterministic ingestion/reindexing workflows.

For production application code, surface the AMR client checklist near the client setup: use the normal `<cache-name>.<region>.redis.azure.net` host on port `10000`, enable TLS or `rediss://`, keep certificate validation on, prefer Microsoft Entra or managed identity where supported, validate required configuration at startup, reuse a singleton/pool/multiplexer, set connect/socket/command timeouts, use bounded jittered retries, refresh Entra tokens before expiry, and log/measure authentication failures, token-refresh events, connection failures, and Redis latency. Do not reuse Azure Cache for Redis defaults such as port `6380`; Azure Managed Redis production clients use port `10000`.

Azure Managed Redis uses the `default` database / database 0 pattern. It does not support Redis logical-database multi-tenancy with `SELECT`, numbered DB indexes, or `db=N` connection settings the way older Azure Cache for Redis designs often did. If code uses Redis DB indexes for tenants, environments, or tests, refactor to explicit key prefixes, tenant-aware metadata filters, scoped data access policies/key patterns, and separate AMR caches for hard tenant isolation.

For DB-index, `SELECT`, cluster-policy, multi-key command, transaction, or Lua reviews, include the full compatibility checklist in the answer: DB0/default database, prefix-based logical separation, `NoCluster` versus `OSSCluster` client assumptions, hash tags, the `CROSSSLOT` failure risk, and AMR client basics: normal AMR host, TLS on port `10000`, certificate validation, and a reusable singleton/pool/multiplexer.

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
2. Select the smallest correct Redis structure and define DB0/default database use, key names, TTLs, size bounds, logical key-prefix boundaries, and cluster hash tags.
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
- `search-*` - Combine vector search with metadata filters and limit returned fields.
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
