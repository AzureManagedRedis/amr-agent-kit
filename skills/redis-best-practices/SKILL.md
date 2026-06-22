---
name: redis-best-practices
description: |
  Redis development patterns and best practices, optimized for Azure Managed Redis.
  Use when writing, reviewing, or refactoring application code that interacts with
  Redis on AMR. Triggers on tasks involving Redis, caching, session storage,
  pub/sub, queues, leaderboards, rate limiting, key-value operations, data
  structure selection, key design, connection handling, memory optimization, or
  Redis resilience.
  Do NOT use for: Azure Managed Redis infrastructure provisioning, AI-specific
  vector search or RAG patterns, or general application design unrelated to Redis.
license: MIT
metadata:
  author: Microsoft
  version: "1.0.0"
---

# Redis Best Practices (Azure Managed Redis)

Development patterns and best practices for building applications with Redis on Azure Managed Redis. This skill contains 37 rules across 10 categories, prioritized by impact to guide code generation, refactoring, and review.

## Scope

- Writing new code that interacts with Redis
- Choosing data structures for your use case
- Designing key naming conventions
- Implementing caching strategies
- Building queues, leaderboards, or rate limiters
- Optimizing connection handling
- Working with pub/sub or streams

## Agent Guidance

### Apply Critical Rules First

Start with Data Structures and Key Design. Incorrect data structures, missing TTLs, large keys, unsafe cluster key placement, or production use of `KEYS` usually require design changes before smaller command-level optimizations matter.

### Prefer AMR-Safe Defaults

When generating Redis client code for Azure Managed Redis, default to TLS-enabled connections, explicit timeouts, bounded retries, connection pooling or multiplexing, and Microsoft Entra authentication where appropriate.

### Separate Redis Use Cases

Identify the user's Redis workload before recommending code:

| User Intent | Signal Phrases | Primary Categories |
|---|---|---|
| Model application data | "data structure", "schema", "hash", "set", "leaderboard", "counter" | Data Structures, Key Design |
| Improve Redis performance | "slow", "latency", "round trips", "bulk", "batch" | Commands & Patterns, Connection Management |
| Implement caching | "cache", "TTL", "stale", "stampede" | Caching Strategies, Key Design |
| Build app primitives | "sessions", "rate limit", "lock", "queue" | Common Use Cases, Pub/Sub & Streams |
| Harden production behavior | "retry", "timeout", "health", "memory", "resilience" | Connection Management, Memory Optimization, Error Handling & Resilience |

## Available Resources

- `AGENTS.md` - Full compiled guidance with expanded rules, examples, and references.
- `rules/` - Individual rule files for targeted guidance.
- `rules/_sections.md` - Category ordering, impact, and descriptions.
- `metadata.json` - Version, abstract, and reference links.

## Redis Best Practices Workflow

1. Identify the Redis use case and data access pattern.
2. Select the smallest correct Redis data structure for the operation.
3. Design namespaced keys with TTLs, size limits, and cluster hash tags where needed.
4. Choose efficient commands and batch round trips with pipelining or MGET/MSET.
5. Configure AMR-safe connection handling, authentication, timeouts, and retries.
6. Add resilience, memory, and health-check safeguards for production workloads.

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

## Quick Reference

### 1. Data Structures (CRITICAL)

- `ds-use-hashes-for-objects` - Store related fields in hashes for 10x memory savings
- `ds-choose-sets-for-uniqueness` - Use sets for unique collections with O(1) membership
- `ds-sorted-sets-for-rankings` - Use sorted sets for leaderboards and ranked data
- `ds-lists-for-queues` - Use lists for FIFO/LIFO queues
- `ds-strings-for-counters` - Use INCR/DECR for atomic counters
- `ds-use-hyperloglog-for-cardinality` - Count unique items with 12KB fixed memory

### 2. Key Design (CRITICAL)

- `key-use-colons-for-namespacing` - Use colons to namespace keys (e.g., user:1000:profile)
- `key-use-hash-tags-for-cluster` - Use hash tags to keep related keys in the same slot
- `key-set-ttl-on-cache-keys` - Always set expiration on cache keys
- `key-avoid-large-keys` - Keep keys under 1KB, values under 100KB
- `key-use-scan-not-keys` - Use SCAN instead of KEYS in production

### 3. Commands & Patterns (HIGH)

- `cmd-use-pipelining-for-bulk` - Pipeline commands to reduce network round trips
- `cmd-use-multi-exec-for-atomicity` - Use MULTI/EXEC for atomic transactions
- `cmd-use-lua-for-complex-atomicity` - Use Lua scripts for complex atomic operations
- `cmd-use-mget-mset-for-batches` - Use MGET/MSET for batch key operations

### 4. Connection Management (HIGH)

- `conn-reuse-sdk-clients` - Reuse SDK clients and pools for the process lifetime
- `conn-require-tls-amr-endpoints` - Use TLS-enabled Azure Managed Redis endpoints and ports
- `conn-use-connection-pooling` - Use TLS-enabled AMR connection pools to avoid exhaustion
- `conn-configure-timeouts` - Set socket, connect, and command timeouts for AMR network conditions
- `conn-use-entra-authentication` - Use Microsoft Entra authentication on Azure Managed Redis
- `conn-refresh-entra-tokens` - Refresh Entra tokens before long-lived connections expire

### 5. Caching Strategies (HIGH)

- `cache-use-cache-aside-pattern` - Implement cache-aside (lazy loading) pattern
- `cache-prevent-cache-stampede` - Use locking or probabilistic refresh to prevent stampedes

### 6. Common Use Cases (MEDIUM-HIGH)

- `use-distributed-locks-safely` - Implement locks with unique tokens and TTL
- `use-rate-limiting-patterns` - Use sliding window or token bucket algorithms
- `use-sessions-with-expiration` - Store sessions in hashes with TTL

### 7. Pub/Sub & Streams (MEDIUM)

- `msg-use-pubsub-for-broadcast` - Use Pub/Sub for ephemeral fan-out messaging
- `msg-use-streams-for-reliable-messaging` - Use Streams for persistent, reliable queues

### 8. JSON & Search (MEDIUM)

- `stack-use-json-for-documents` - Use RedisJSON for nested document storage
- `stack-use-search-for-queries` - Use Redis Search for secondary indexes and full-text search

### 9. Memory Optimization (MEDIUM)

- `memory-use-efficient-encodings` - Keep data small to use ziplist/listpack encoding
- `memory-monitor-and-set-limits` - Set maxmemory and appropriate eviction policy

### 10. Error Handling & Resilience (LOW-MEDIUM)

- `resilience-handle-connection-errors` - Implement retries with exponential backoff
- `resilience-use-bounded-retries` - Use bounded retries with jitter for transient failures
- `resilience-use-health-checks` - Monitor Redis health with PING and INFO
- `resilience-avoid-keyspace-notifications` - Avoid keyspace notifications for critical workflows
- `resilience-isolate-local-test-configuration` - Keep local and test Redis configuration isolated from production

## How to Use the Rule Files

Read individual rule files for detailed explanations and code examples:

```
rules/ds-use-hashes-for-objects.md
rules/key-use-colons-for-namespacing.md
rules/conn-use-connection-pooling.md
```

Each rule file contains:
- Brief explanation of why it matters
- Incorrect code example with explanation
- Correct code example with explanation
- Additional context and references

## Tips for Effective Redis Guidance

- Recommend the simplest Redis structure that satisfies the access pattern.
- Avoid unbounded scans, unbounded lists, missing TTLs on cache keys, and large values.
- Prefer explicit code examples showing incorrect and correct usage when reviewing or refactoring.
- Use `AGENTS.md` when the user needs full expanded examples or references.

## Full Compiled Document

For the complete guide with all rules expanded, use `AGENTS.md`.
