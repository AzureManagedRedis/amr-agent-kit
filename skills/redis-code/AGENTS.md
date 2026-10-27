# Redis Code Best Practices Rule Index

**Version 1.0.0**  
Microsoft  
February 2026

Comprehensive Redis application and AI coding patterns for Azure Managed Redis, designed for AI agents and LLMs. Contains 62 rules across 19 categories, spanning data structures, key design, DB0/key-prefix separation, commands, connection handling, caching, messaging, resilience, vector search, RAG, semantic caching, LLM memory, embedding pipelines, and agent state. Critical guardrails: use database 0 and key prefixes, not SELECT or numbered databases; EnterpriseCluster cross-slot DEL/MSET/UNLINK exceptions do not apply with active geo-replication; Search requires EnterpriseCluster and NoEviction; verify RedisJSON policy compatibility against public service documentation rather than inferring support or incompatibility; active geo-replication supports only Search and JSON. Validate SKU, region, preview status, flash restrictions, and geo compatibility before provisioning. Each rule includes detailed explanations, incorrect vs. correct examples, and links to official Azure, Redis, and Redis AI documentation.

This generated file is a compact catalog, not a complete instruction bundle. Start with [SKILL.md](SKILL.md), select only the categories relevant to the task, and then read the linked source rules under `rules/`. Do not load every rule unless the task genuinely spans the full skill.

## 1. Data Structures

**Category impact: CRITICAL**

- **1.1** [Use Hashes for Object Storage](rules/ds-use-hashes-for-objects.md) — CRITICAL
- **1.2** [Use HyperLogLog for Cardinality Estimation](rules/ds-use-hyperloglog-for-cardinality.md) — MEDIUM
- **1.3** [Use Lists for Queues and Stacks](rules/ds-lists-for-queues.md) — HIGH
- **1.4** [Use Sets for Unique Collections](rules/ds-choose-sets-for-uniqueness.md) — CRITICAL
- **1.5** [Use Sorted Sets for Rankings and Leaderboards](rules/ds-sorted-sets-for-rankings.md) — CRITICAL
- **1.6** [Use Strings with INCR for Atomic Counters](rules/ds-strings-for-counters.md) — HIGH

## 2. Key Design

**Category impact: CRITICAL**

- **2.1** [Always Set TTL on Cache Keys](rules/key-set-ttl-on-cache-keys.md) — CRITICAL
- **2.2** [Avoid Very Large Keys and Values](rules/key-avoid-large-keys.md) — HIGH
- **2.3** [Use Colons for Key Namespacing](rules/key-use-colons-for-namespacing.md) — CRITICAL
- **2.4** [Use Hash Tags for Multi-Key Operations in Clustered Redis](rules/key-use-hash-tags-for-cluster.md) — MEDIUM-HIGH
- **2.5** [Use SCAN Instead of KEYS in Production](rules/key-use-scan-not-keys.md) — CRITICAL

## 3. Commands & Patterns

**Category impact: HIGH**

- **3.1** [Use Lua Scripts for Complex Atomic Operations](rules/cmd-use-lua-for-complex-atomicity.md) — HIGH
- **3.2** [Use MGET/MSET for Batch Key Operations](rules/cmd-use-mget-mset-for-batches.md) — MEDIUM
- **3.3** [Use MULTI/EXEC for Atomic Operations](rules/cmd-use-multi-exec-for-atomicity.md) — HIGH
- **3.4** [Use Pipelining for Bulk Operations](rules/cmd-use-pipelining-for-bulk.md) — HIGH

## 4. Connection Management

**Category impact: HIGH**

- **4.1** [Configure Connection Timeouts](rules/conn-configure-timeouts.md) — HIGH
- **4.2** [Refresh Entra Tokens Before Expiry](rules/conn-refresh-entra-tokens.md) — HIGH
- **4.3** [Reuse SDK Clients and Pools](rules/conn-reuse-sdk-clients.md) — CRITICAL
- **4.4** [Use Connection Pooling](rules/conn-use-connection-pooling.md) — CRITICAL
- **4.5** [Use Microsoft Entra Authentication for Azure Managed Redis](rules/conn-use-entra-authentication.md) — HIGH
- **4.6** [Use TLS and Service-Returned Azure Managed Redis Endpoints](rules/conn-require-tls-amr-endpoints.md) — CRITICAL

## 5. Caching Strategies

**Category impact: HIGH**

- **5.1** [Prevent Cache Stampede](rules/cache-prevent-cache-stampede.md) — HIGH
- **5.2** [Use Cache-Aside Pattern for Reading](rules/cache-use-cache-aside-pattern.md) — HIGH

## 6. Common Use Cases

**Category impact: MEDIUM-HIGH**

- **6.1** [Implement Distributed Locks Safely](rules/use-distributed-locks-safely.md) — CRITICAL
- **6.2** [Store Sessions with Automatic Expiration](rules/use-sessions-with-expiration.md) — HIGH
- **6.3** [Use Redis for Rate Limiting](rules/use-rate-limiting-patterns.md) — HIGH

## 7. Pub/Sub & Streams

**Category impact: MEDIUM**

- **7.1** [Integrate Azure Events for Cache Invalidation](rules/msg-integrate-azure-events-for-cache-invalidation.md) — HIGH
- **7.2** [Use Pub/Sub for Real-Time Broadcasting](rules/msg-use-pubsub-for-broadcast.md) — MEDIUM
- **7.3** [Use Streams for Reliable Messaging](rules/msg-use-streams-for-reliable-messaging.md) — HIGH

## 8. JSON & Search

**Category impact: MEDIUM**

- **8.1** [Use Redis Search for Complex Queries](rules/stack-use-search-for-queries.md) — MEDIUM
- **8.2** [Use RedisJSON for Complex Documents](rules/stack-use-json-for-documents.md) — MEDIUM

## 9. Memory Optimization

**Category impact: MEDIUM**

- **9.1** [Monitor Memory and Choose Capacity and Eviction](rules/memory-monitor-and-set-limits.md) — CRITICAL
- **9.2** [Use Memory-Efficient Data Structures](rules/memory-use-efficient-encodings.md) — HIGH

## 10. Error Handling & Resilience

**Category impact: LOW-MEDIUM**

- **10.1** [Avoid Keyspace Notifications for Critical Workflows](rules/resilience-avoid-keyspace-notifications.md) — MEDIUM-HIGH
- **10.2** [Handle Connection Errors Gracefully](rules/resilience-handle-connection-errors.md) — CRITICAL
- **10.3** [Implement Redis Health Checks](rules/resilience-use-health-checks.md) — HIGH
- **10.4** [Isolate Local and Test Redis Configuration](rules/resilience-isolate-local-test-configuration.md) — MEDIUM-HIGH
- **10.5** [Use Bounded Retries with Jitter](rules/resilience-use-bounded-retries.md) — HIGH

## 11. Vector Index Design

**Category impact: CRITICAL**

- **11.1** [Keep Embedding Dimensions and Distance Metric Aligned](rules/vec-align-dimensions-and-distance-metric.md) — CRITICAL
- **11.2** [Store Vectors with Filterable Metadata](rules/vec-store-vectors-with-metadata.md) — CRITICAL

## 12. Search Query Patterns

**Category impact: HIGH**

- **12.1** [Limit K and Returned Fields for AI Retrieval](rules/search-limit-k-and-returned-fields.md) — HIGH
- **12.2** [Match Search and JSON Modules to the Cluster Policy](rules/search-use-enterprise-policy-for-modules.md) — CRITICAL
- **12.3** [Use Hybrid Vector Search with Metadata Filters](rules/search-use-hybrid-vector-and-metadata-filters.md) — CRITICAL

## 13. Retrieval-Augmented Generation

**Category impact: HIGH**

- **13.1** [Chunk Documents with Stable Size and Overlap](rules/rag-chunk-content-with-stable-windowing.md) — HIGH
- **13.2** [Enforce Tenant and ACL Boundaries in RAG](rules/rag-enforce-tenant-and-acl-boundaries.md) — CRITICAL
- **13.3** [Store Source and Citation Metadata for RAG](rules/rag-store-source-citations-in-index.md) — HIGH

## 14. Semantic Caching

**Category impact: HIGH**

- **14.1** [Invalidate Semantic Cache on Knowledge and Policy Changes](rules/semcache-invalidate-on-knowledge-and-policy-changes.md) — HIGH
- **14.2** [Tune Semantic Cache Threshold and TTL by Use Case](rules/semcache-set-threshold-and-ttl-by-use-case.md) — HIGH
- **14.3** [Version Semantic Cache Keys by Model and Prompt](rules/semcache-version-keys-by-model-and-prompt.md) — HIGH

## 15. LLM Memory

**Category impact: MEDIUM-HIGH**

- **15.1** [Set TTL and Sliding Windows for LLM Session Memory](rules/llm-set-session-ttl-and-window.md) — HIGH
- **15.2** [Summarize Older Turns to Preserve Context Budget](rules/llm-summarize-long-conversations.md) — HIGH

## 16. AI Agent State

**Category impact: MEDIUM-HIGH**

- **16.1** [Persist Agent State and Checkpoints in Redis](rules/agent-persist-agent-state-and-checkpoints.md) — MEDIUM-HIGH
- **16.2** [Resume Agents from Idempotent Checkpoints](rules/agent-resume-from-idempotent-checkpoints.md) — MEDIUM-HIGH
- **16.3** [Use Redis Streams for Multi-Step Agent Workflows](rules/agent-use-streams-for-multi-step-workflows.md) — MEDIUM-HIGH

## 17. Embedding Pipelines

**Category impact: MEDIUM**

- **17.1** [Batch Embedding Generation and Redis Upserts](rules/embed-batch-embedding-and-upsert.md) — MEDIUM
- **17.2** [Make Embedding Ingestion Idempotent](rules/embed-make-ingestion-idempotent.md) — HIGH
- **17.3** [Standardize One Embedding Model per Index](rules/embed-standardize-model-per-index.md) — MEDIUM

## 18. Framework Integration

**Category impact: MEDIUM**

- **18.1** [Use Microsoft Agent Framework with Redis for Durable Agent State](rules/integrate-use-microsoft-agent-framework.md) — MEDIUM
- **18.2** [Use RedisVL for Index Schema and Query Lifecycle](rules/integrate-use-redisvl-for-schema-and-queries.md) — MEDIUM

## 19. AI Performance & Cost

**Category impact: MEDIUM**

- **19.1** [Pipeline Bulk Vector Ingestion](rules/perf-pipeline-bulk-ingestion.md) — LOW-MEDIUM
- **19.2** [Size for Vector Workloads and Memory Footprint](rules/perf-size-for-vector-workloads.md) — LOW-MEDIUM
- **19.3** [Tune HNSW Runtime Parameters for SLA Targets](rules/perf-tune-hnsw-runtime-params.md) — LOW-MEDIUM

## Product References

1. [https://learn.microsoft.com/en-us/azure/redis/overview](https://learn.microsoft.com/en-us/azure/redis/overview)
2. [https://learn.microsoft.com/en-us/azure/redis/architecture](https://learn.microsoft.com/en-us/azure/redis/architecture)
3. [https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication](https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication)
4. [https://redis.io/docs/latest/develop/](https://redis.io/docs/latest/develop/)
5. [https://redis.io/docs/latest/develop/data-types/](https://redis.io/docs/latest/develop/data-types/)
6. [https://redis.io/docs/latest/develop/data-types/hashes/](https://redis.io/docs/latest/develop/data-types/hashes/)
7. [https://redis.io/docs/latest/develop/data-types/sorted-sets/](https://redis.io/docs/latest/develop/data-types/sorted-sets/)
8. [https://redis.io/docs/latest/develop/data-types/streams/](https://redis.io/docs/latest/develop/data-types/streams/)
9. [https://redis.io/docs/latest/develop/use/pipelining/](https://redis.io/docs/latest/develop/use/pipelining/)
10. [https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/)
11. [https://redis.io/docs/latest/develop/clients/](https://redis.io/docs/latest/develop/clients/)
12. [https://redis.io/docs/latest/develop/clients/pools-and-muxing/](https://redis.io/docs/latest/develop/clients/pools-and-muxing/)
13. [https://redis.io/docs/latest/develop/interact/search-and-query/](https://redis.io/docs/latest/develop/interact/search-and-query/)
14. [https://redis.io/docs/latest/develop/data-types/json/](https://redis.io/docs/latest/develop/data-types/json/)
15. [https://redis.io/docs/latest/develop/ai/search-and-query/vectors/](https://redis.io/docs/latest/develop/ai/search-and-query/vectors/)
16. [https://redis.io/docs/latest/develop/ai/redisvl/](https://redis.io/docs/latest/develop/ai/redisvl/)
17. [https://www.redisvl.com/](https://www.redisvl.com/)
18. [https://learn.microsoft.com/en-us/azure/event-grid/concepts](https://learn.microsoft.com/en-us/azure/event-grid/concepts)
19. [https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-dead-letter-queues](https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-dead-letter-queues)
