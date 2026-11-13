---
name: redis-code
description: |
  Redis coding best practices for Azure Managed Redis. Use when writing,
  reviewing, or refactoring Redis application code, caching, session storage,
  queues, pub/sub, streams, data structures, key design, connection handling,
  vector search, RAG, semantic caching, LLM memory, embeddings, or AI agent
  state on Azure Managed Redis.
  For client changes when migrating from Azure Cache for Redis (any tier) to AMR,
  use only to route to the separate migration skills.
  Do NOT use for: Azure Managed Redis infrastructure provisioning, Private Link,
  SKU selection, high availability, geo-replication, persistence, diagnostics,
  or Azure resources unrelated to Redis application code.
license: MIT
metadata:
  author: Microsoft
  version: "0.1.0"
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

- **Use database 0 and key prefixes.** AMR documents a single database and blocks `SELECT`; do not recommend numbered databases or a `NoCluster` exception. → `rules/key-use-colons-for-namespacing.md`
- **Multi-key safety is policy- and geo-specific.** `OSSCluster` requires same-slot keys. `EnterpriseCluster` permits selected cross-slot commands, but active geo-replication requires same-slot keys for `DEL`, `MSET`, and `UNLINK`; only `MGET`, `EXISTS`, and `TOUCH` retain the cross-slot exception. Transactions, Lua-with-KEYS, and destination-key commands require co-location; `NoCluster` is unsharded. → `rules/key-use-hash-tags-for-cluster.md`
- **Use the service-returned endpoint and port.** `10000` is the default database port, not a universal constant; do not reject a valid non-default port or hardcode public-cloud DNS. → `rules/conn-require-tls-amr-endpoints.md`
- **Match modules to cluster policy.** Search (RediSearch) requires `EnterpriseCluster` and `NoEviction`; do not infer RedisJSON policy compatibility from Search's restriction. Verify the selected combination in current public service documentation; active geo-replication supports only Search and JSON. → `rules/search-use-enterprise-policy-for-modules.md`
- **Memory is service-managed.** Do not `CONFIG SET maxmemory` from a client; choose SKU and eviction policy in Azure and monitor effective memory. → `rules/memory-monitor-and-set-limits.md`
- **Semantic-cache keys are not tenant isolation.** Store tenant, effective ACL hash, model/embedding IDs, prompt, knowledge, and policy versions as filterable TAG fields; require all as prefilters on every lookup and fail closed before reads or writes when scope is missing. → `rules/semcache-version-keys-by-model-and-prompt.md` and `rules/semcache-invalidate-on-knowledge-and-policy-changes.md`

### Route Migration Requests

For migration from Azure Cache for Redis or Azure Cache for Redis Enterprise to AMR, including assessment, IaC conversion, client changes, cutover, or rollback, hand off before using this kit's ordinary workflows:

| Source service/tier | Migration skill |
|---|---|
| Azure Cache for Redis Basic, Standard, or Premium (ACR/OSS) | [amr-migration-skill](https://github.com/AzureManagedRedis/amr-migration-skill) |
| Azure Cache for Redis Enterprise or Enterprise Flash (ACRE) | [acre-to-amr-migration-skill](https://github.com/AzureManagedRedis/acre-to-amr-migration-skill) |

If the source service/tier is unclear, ask before choosing a skill; do not infer it from the target AMR tier or cluster policy. These skills are distributed separately, not bundled with this kit. If the matching skill is installed, invoke it; otherwise, give the user that skill's repository link and point them to its installation instructions.

Continue using this kit for standalone AMR infrastructure or application work.

### Keep Code and Infrastructure Boundaries Clear

Use this skill for code-level decisions: clients, keys, commands, indexes, retrieval logic, cache policy, ingestion flows, and agent state. Use `azure-redis-infra` when the task is about provisioning, SKUs, Private Link, cluster policy, persistence, HA, geo-replication, diagnostics, or Azure resource configuration.

### Apply Critical Rules First

Start with data structures, key design, vector index schema, and tenant/security boundaries. Incorrect structures, unbounded keys, unsupported logical-database (`SELECT`/`db=N`) tenancy on AMR, unsafe cluster key placement, mismatched embedding dimensions, or missing RAG access controls usually require design changes before smaller command-level optimizations matter.

### Prefer AMR-Safe Code Defaults

When generating Redis client code for Azure Managed Redis, default to TLS-enabled endpoints, explicit timeouts, bounded retries with jitter, connection pooling or multiplexing, key TTLs, Microsoft Entra authentication where appropriate, and deterministic ingestion/reindexing workflows.

For production application code, surface the AMR client checklist near the client setup: read the service-returned host name and port from deployment configuration, enable TLS or `rediss://`, keep certificate validation on, prefer Microsoft Entra or managed identity where supported, validate required configuration at startup, reuse a singleton/pool/multiplexer, set connect/socket/command timeouts, use bounded jittered retries, refresh Entra tokens before expiry, and log/measure authentication failures, token-refresh events, connection failures, and Redis latency. In public Azure the default AMR endpoint resembles `<cache-name>.<region>.redis.azure.net` and the default database port is `10000`, but custom database ports and cloud-specific DNS suffixes are supported; do not replace the service-returned values with Azure Cache for Redis defaults such as port `6380`. With `OSSCluster`, cluster-aware clients also connect directly to nodes on the documented `85xx` port range; allow those ports through network controls and never hardcode them.

Use database 0 and explicit key prefixes for tenants, environments, and tests. The [public AMR configuration documentation](https://learn.microsoft.com/en-us/azure/redis/configure#other-configuration-information) documents a single database per instance and lists `SELECT` as blocked, without a `NoCluster` exception. Do not recommend numbered databases, `db=N` tenancy, or live `SELECT` probes as a workaround. Refactor DB-index tenancy to explicit key prefixes, tenant-aware metadata filters, scoped data access policies/key patterns, and separate AMR caches for hard tenant isolation.

For logical-database, `SELECT`, cluster-policy, multi-key command, transaction, or Lua reviews, use database 0 with key prefixes and make multi-key guidance policy- and geo-specific: `NoCluster` is unsharded (no slot constraint); `OSSCluster` requires same-slot placement (hash tags) for every multi-key command, transaction, and Lua script. Under `EnterpriseCluster` without active geo-replication, `MGET`, `MSET`, `DEL`, `UNLINK`, `EXISTS`, and `TOUCH` can span slots. With active geo-replication, `DEL`, `MSET`, and `UNLINK` require same-slot keys; only `MGET`, `EXISTS`, and `TOUCH` retain the cross-slot exception. Transactions, Lua scripts that declare keys in `KEYS`, and destination-key commands still need co-located keys. Hash tags are the portable co-location mechanism, not a universal requirement for every Enterprise command. See the [public multi-key compatibility guidance](https://learn.microsoft.com/en-us/azure/redis/choose-clustering-policy#multikey-commands-and-crossslot-behavior). Include AMR client basics: service-returned host and port, TLS with certificate validation, and a reusable singleton/pool/multiplexer.

### Keep Module and Cluster-Policy Claims Exact

Do not group Search and RedisJSON under one cluster-policy rule. The [public modules documentation](https://learn.microsoft.com/en-us/azure/redis/redis-modules) requires `EnterpriseCluster` and `NoEviction` for Search, and supports only Search and JSON with active geo-replication. It does not explicitly establish RedisJSON compatibility with `OSSCluster`; do not assert either support or incompatibility without a public service reference. Before provisioning, validate the complete SKU, policy, module, region, preview status, flash restrictions, and geo combination.

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

- [AGENTS.md](AGENTS.md) - Compact generated rule catalog.
- `rules/` - Detailed source rules loaded individually as needed.
- `rules/_sections.md` - Category ordering, impact, and descriptions.
- `metadata.json` - Version, abstract, and reference links.

Use progressive disclosure: select the smallest matching category below, open [AGENTS.md](AGENTS.md) at that category, and read only the linked rules needed for the task. Do not load the complete rule corpus by default.

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

- [Data structures](AGENTS.md#1-data-structures) - Hashes, sets, sorted sets, lists, counters, and cardinality.
- [Key design](AGENTS.md#2-key-design) - Namespaced, TTL-bound, cluster-safe keys and production-safe discovery.
- [Commands and patterns](AGENTS.md#3-commands--patterns) - Pipelining, transactions, Lua, and batch operations.
- [Connection management](AGENTS.md#4-connection-management) - TLS, pooling, timeouts, Entra authentication, and token refresh.
- [Caching strategies](AGENTS.md#5-caching-strategies) - Cache-aside and stampede prevention.
- [Common use cases](AGENTS.md#6-common-use-cases) - Sessions, rate limiting, and distributed locks.
- [Pub/Sub and Streams](AGENTS.md#7-pubsub--streams) - Ephemeral fan-out, reliable messaging, and invalidation workflows.
- [JSON and Search](AGENTS.md#8-json--search) - Document and query workloads.
- [Memory optimization](AGENTS.md#9-memory-optimization) - Encodings, memory policies, and fragmentation.
- [Error handling and resilience](AGENTS.md#10-error-handling--resilience) - Bounded retries, health checks, and failure handling.

### AI Application Code

- [Vector index design](AGENTS.md#11-vector-index-design) - Metadata, dimensions, and distance metrics.
- [Search query patterns](AGENTS.md#12-search-query-patterns) - Match Search/JSON to the cluster policy, then combine vector search with metadata filters and bounded results.
- [RAG](AGENTS.md#13-retrieval-augmented-generation) - Citations, deterministic chunking, and tenant/ACL boundaries.
- [Semantic caching](AGENTS.md#14-semantic-caching) - Versioning, thresholds, TTLs, and invalidation.
- [LLM memory](AGENTS.md#15-llm-memory) - Bounded conversation memory and summarization.
- [AI agent state](AGENTS.md#16-ai-agent-state) - Idempotent checkpoints and streams.
- [Embedding pipelines](AGENTS.md#17-embedding-pipelines) - Batched, idempotent upserts.
- [Framework integration](AGENTS.md#18-framework-integration) - RedisVL and Microsoft Agent Framework.
- [AI performance and cost](AGENTS.md#19-ai-performance--cost) - Vector sizing and ingestion/query tuning.

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

Use [AGENTS.md](AGENTS.md) only as a catalog; load the selected rule file for complete guidance, examples, and references.
