# Sections

This file defines the generated AMR rollup sections, their ordering, impact levels, and descriptions.
The section ID in parentheses is the filename prefix used by source skill rule files.

---

## 1. Redis Application Data Structures (ds)

**Impact:** CRITICAL

**Description:** Choose the correct Redis data structure before optimizing commands or infrastructure. Strings, Lists, Sets, Sorted Sets, Hashes, Streams, and probabilistic structures each have different time complexity, memory, and modeling trade-offs.

---

## 2. Redis Application Key Design (key)

**Impact:** CRITICAL

**Description:** Design namespaced, bounded, TTL-aware keys that are safe for production scans and cluster placement. Key naming, size limits, expirations, and hash tags affect maintainability, memory pressure, and sharding behavior.

---

## 3. Redis Application Commands and Patterns (cmd)

**Impact:** HIGH

**Description:** Use efficient Redis commands and atomic patterns to reduce network round trips and avoid blocking or race-prone workflows. Covers pipelining, transactions, Lua scripting, and batch operations.

---

## 4. Redis Application Connection Management (conn)

**Impact:** HIGH

**Description:** Configure Redis clients for Azure Managed Redis with TLS, bounded connection pools or multiplexing, explicit timeouts, retries, and identity-aware authentication refresh behavior.

---

## 5. Redis Application Caching Strategies (cache)

**Impact:** HIGH

**Description:** Apply caching patterns that maximize hit rate while controlling stale data and backend load. Covers cache-aside, TTL design, invalidation, and stampede prevention.

---

## 6. Redis Application Common Use Cases (use)

**Impact:** MEDIUM-HIGH

**Description:** Use Redis safely for common application primitives such as sessions, rate limiting, distributed locks, counters, queues, and leaderboards.

---

## 7. Redis Application Messaging and Streams (msg)

**Impact:** MEDIUM

**Description:** Choose between ephemeral Pub/Sub fan-out and durable Redis Streams with consumer groups based on delivery, replay, and reliability requirements.

---

## 8. Redis Application JSON and Search (stack)

**Impact:** MEDIUM

**Description:** Use RedisJSON and Redis Search for document storage, secondary indexes, full-text search, and query patterns when module support and cluster policy fit the workload.

---

## 9. Redis Application Memory Optimization (memory)

**Impact:** MEDIUM

**Description:** Control memory growth with efficient encodings, maxmemory policy, TTLs, fragmentation monitoring, and bounded value sizes.

---

## 10. Redis Application Error Handling and Resilience (resilience)

**Impact:** LOW-MEDIUM

**Description:** Build production resilience with graceful Redis failure handling, health checks, retries, circuit breakers, and degradation paths.

---

## 11. Redis AI Vector Storage and Indexing (vec)

**Impact:** CRITICAL

**Description:** Store embeddings with metadata and configure vector indexes correctly. Covers Redis hashes or JSON, HNSW and FLAT indexes, dimensions, distance metrics, and index parameters.

---

## 12. Redis AI Similarity Search (search)

**Impact:** CRITICAL

**Description:** Implement similarity search with correct KNN or range queries, scoring, distance metrics, returned fields, module prerequisites, and AMR cluster policy constraints.

---

## 13. Redis AI RAG Implementation (rag)

**Impact:** HIGH

**Description:** Build Retrieval Augmented Generation pipelines with stable chunking, source citations, metadata filters, retrieval payload control, and prompt context management.

---

## 14. Redis AI Semantic Caching (semcache)

**Impact:** HIGH

**Description:** Reduce LLM cost and latency by caching semantically similar responses with tuned similarity thresholds, TTLs, model-aware key versioning, and invalidation strategies.

---

## 15. Redis AI LLM Memory and Sessions (llm)

**Impact:** HIGH

**Description:** Manage conversation history, session TTLs, sliding windows, summarization, and context retrieval for multi-turn LLM applications.

---

## 16. Redis AI Agent Patterns (agent)

**Impact:** MEDIUM-HIGH

**Description:** Use Redis as an agent memory, checkpoint, and workflow state layer for tool execution, multi-step reasoning, and durable agent orchestration.

---

## 17. Redis AI Embeddings and Models (embed)

**Impact:** MEDIUM

**Description:** Standardize embedding generation and model selection, including dimensions, normalization, batching, model upgrades, and index boundaries.

---

## 18. Redis AI Framework Integration (integrate)

**Impact:** MEDIUM

**Description:** Integrate Redis with AI frameworks and libraries such as RedisVL, LangChain, LlamaIndex, Semantic Kernel, and Microsoft Agent Framework.

---

## 19. Redis AI Performance Tuning (perf)

**Impact:** LOW-MEDIUM

**Description:** Tune Redis for AI workloads with bulk ingestion, pipelining, HNSW runtime parameters, vector memory sizing, query optimization, and scaling considerations.

---

## 20. AMR Infrastructure Provisioning and Sizing (provision)

**Impact:** CRITICAL

**Description:** Select the right Azure Managed Redis tier, SKU, region, capacity, and modules at creation time to meet latency, throughput, memory, availability, and cost requirements.

---

## 21. AMR Infrastructure Networking and Access (network)

**Impact:** CRITICAL

**Description:** Design private, reliable AMR connectivity with Private Link, disabled public access where appropriate, DNS integration, and cluster policy port requirements.

---

## 22. AMR Infrastructure Security and Identity (security)

**Impact:** CRITICAL

**Description:** Enforce TLS, prefer Microsoft Entra authentication, manage access keys carefully, apply Azure RBAC, and avoid secrets in application configuration.

---

## 23. AMR Infrastructure Availability and Zone Redundancy (availability)

**Impact:** HIGH

**Description:** Plan high availability, zone redundancy, failover behavior, and client resilience for node, rack, or availability zone failures.

---

## 24. AMR Infrastructure Geo-Replication and DR (geo)

**Impact:** HIGH

**Description:** Plan active geo-replication, eventual consistency, failover workflows, region strategy, and disaster recovery operations for multi-region continuity.

---

## 25. AMR Infrastructure Data Durability and Backup (durability)

**Impact:** MEDIUM-HIGH

**Description:** Configure persistence and export workflows for recovery, backup, and migration while accounting for feature compatibility and operational limits.

---

## 26. AMR Infrastructure Performance and Cluster Policy (performance)

**Impact:** MEDIUM

**Description:** Choose OSS or Enterprise cluster policy, align clients with cluster behavior and port requirements, and match performance expectations to AMR topology.

---

## 27. AMR Infrastructure Observability and Diagnostics (observability)

**Impact:** MEDIUM

**Description:** Enable Azure Monitor metrics, diagnostic logs, connection auditing, alerts, and dashboards for AMR availability, performance, and security operations.
