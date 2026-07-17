# Sections

This file defines all sections, their ordering, impact levels, and descriptions.
The section ID (in parentheses) is the filename prefix used to group rules.

---

## 1. Data Structures (ds)

**Impact:** CRITICAL

**Description:** Choosing the correct Redis data structure is fundamental to performance and functionality. Redis offers Strings, Lists, Sets, Sorted Sets, Hashes, Streams, and more. Each has specific time complexities and memory characteristics. Using the wrong type leads to inefficient operations, excessive memory usage, and poor scalability.

---

## 2. Key Design (key)

**Impact:** CRITICAL

**Description:** Well-designed keys improve code readability, enable efficient SCAN operations, prevent key collisions, and support logical data organization. Key naming conventions, TTL strategies, and cluster hash tags directly impact maintainability, memory management, and Azure Managed Redis cluster behavior.

---

## 3. Commands & Patterns (cmd)

**Impact:** HIGH

**Description:** Using optimal Redis commands and patterns reduces round trips, prevents blocking operations, and leverages Redis atomic capabilities. Covers pipelining, transactions, Lua scripting, and batch operations.

---

## 4. Connection Management (conn)

**Impact:** HIGH

**Description:** Redis is single-threaded for command execution, making connection handling critical. On Azure Managed Redis, connection pooling, TLS-enabled client configuration, timeout/retry settings, and Entra-aware auth refresh strategies prevent resource exhaustion and maximize throughput.

---

## 5. Caching Strategies (cache)

**Impact:** HIGH

**Description:** Effective caching patterns maximize hit rates and minimize stale data. Covers cache-aside, write-through, write-behind, invalidation strategies, TTL design, and stampede prevention techniques.

---

## 6. Common Use Cases (use)

**Impact:** MEDIUM-HIGH

**Description:** Redis excels at specific use cases beyond simple key-value storage. Patterns for session management, task queues, leaderboards, rate limiting, counters, and distributed locks.

---

## 7. Pub/Sub & Streams (msg)

**Impact:** MEDIUM

**Description:** Redis provides powerful messaging capabilities. Pub/Sub enables ephemeral fan-out, while Streams offer persistent, replayable event logs with consumer groups for reliable processing.

---

## 8. JSON & Search (stack)

**Impact:** MEDIUM

**Description:** Redis Stack extends core Redis with JSON document support and full-text search. Covers JSONPath operations, indexing strategies, and query patterns for document-oriented use cases.

---

## 9. Memory Optimization (memory)

**Impact:** MEDIUM

**Description:** Redis stores all data in memory, making optimization essential. Techniques include choosing memory-efficient encodings, setting appropriate maxmemory policies, using TTLs effectively, and monitoring fragmentation.

---

## 10. Error Handling & Resilience (resilience)

**Impact:** LOW-MEDIUM

**Description:** Production Redis applications need graceful error handling. Covers retry strategies, circuit breakers, timeout configuration, connection error handling, and degradation patterns when Redis is unavailable.

---

## 11. Vector Index Design (vec)

**Impact:** CRITICAL

**Description:** Vector index schema choices define search quality, memory footprint, and query performance. Covers embedding dimensions, distance metrics, metadata fields, and index structures for Redis vector search on Azure Managed Redis.

---

## 12. Search Query Patterns (search)

**Impact:** HIGH

**Description:** Retrieval quality depends on query construction. Covers hybrid vector and metadata filtering, top-k limits, returned fields, and Azure Managed Redis module and cluster-policy constraints.

---

## 13. Retrieval-Augmented Generation (rag)

**Impact:** HIGH

**Description:** RAG systems need reliable ingestion, chunking, citation handling, and tenant/security boundaries. Redis can store vectors, metadata, and retrievable context, but applications must preserve source traceability and access control.

---

## 14. Semantic Caching (semcache)

**Impact:** HIGH

**Description:** Semantic caches reduce LLM cost and latency when similarity thresholds, TTLs, model versions, prompt versions, and invalidation rules are explicit. Poor cache policy can return stale or unsafe answers.

---

## 15. LLM Memory (llm)

**Impact:** MEDIUM-HIGH

**Description:** LLM memory needs bounded windows, summarization, TTLs, and tenant/session isolation. Redis provides fast session and conversation state, but memory must remain scoped and governable.

---

## 16. AI Agent State (agent)

**Impact:** MEDIUM-HIGH

**Description:** Agent workflows need durable checkpoints, idempotent recovery, and coordination primitives. Redis Streams, hashes, and sorted sets can back agent state when keys, TTLs, and replay semantics are designed intentionally.

---

## 17. Embedding Pipelines (embed)

**Impact:** MEDIUM

**Description:** Embedding ingestion should be deterministic, batched, idempotent, and tied to a known model and dimension. Re-indexing and refresh workflows must avoid partial state and duplicate vectors.

---

## 18. Framework Integration (integrate)

**Impact:** MEDIUM

**Description:** AI frameworks and Redis libraries should be configured explicitly for Azure Managed Redis endpoints, TLS, authentication, schema management, and query execution instead of relying on local defaults.

---

## 19. AI Performance & Cost (perf)

**Impact:** MEDIUM

**Description:** Vector and AI workloads need capacity planning across Redis memory, index size, embedding throughput, query latency, and LLM cost. Covers ingestion pipelining, HNSW runtime parameters, and workload sizing.
