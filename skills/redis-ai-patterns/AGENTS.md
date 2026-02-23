# Redis AI Patterns

**Version 1.0.0**  
Redis  
February 2026

> **Note:**  
> This document is mainly for agents and LLMs to follow when maintaining,  
> generating, or refactoring AI applications using Redis. Humans  
> may also find it useful, but guidance here is optimized for automation  
> and consistency by AI-assisted workflows.

---

## Abstract

Patterns and best practices for building AI and ML applications with Redis on Azure Managed Redis (Redis Enterprise 7.4). Covers vector storage and indexing, similarity search, RAG implementation, semantic caching, LLM memory management, and framework integration. Each rule includes detailed explanations with incorrect vs. correct code examples.

---

## Table of Contents

2. [Similarity Search](#2-similarity-search) — **CRITICAL**
   - 2.1 [Use Enterprise Cluster Policy for RediSearch and RedisJSON](#21-use-enterprise-cluster-policy-for-redisearch-and-redisjson)
9. [Performance Tuning](#9-performance-tuning) — **LOW-MEDIUM**
   - 9.1 [Size for Vector Workloads and Memory Footprint](#91-size-for-vector-workloads-and-memory-footprint)

---

## 2. Similarity Search

**Impact: CRITICAL**

Effective similarity search is core to vector database usage. Covers KNN queries, range queries, hybrid search combining vector similarity with attribute filters, distance metrics (cosine, L2, IP), and result scoring.

---

### 2.1 Use Enterprise Cluster Policy for RediSearch and RedisJSON

**Impact: CRITICAL (avoids unsupported module/cluster combinations)**

On Azure Managed Redis, RediSearch and RedisJSON require the Enterprise cluster policy. OSS cluster policy doesn't support RediSearch. Select the Enterprise policy at provisioning time when you need vector search or JSON documents.

**Incorrect: OSS cluster with RediSearch/RedisJSON**

```text
Cluster policy: OSS
Modules: RediSearch, RedisJSON
Result: module not supported with OSS policy
```

**Correct: Enterprise cluster with modules**

```text
Cluster policy: Enterprise
Modules: RediSearch, RedisJSON
Result: vector search and JSON features available
```

Reference: [https://learn.microsoft.com/en-us/azure/redis/architecture](https://learn.microsoft.com/en-us/azure/redis/architecture)

---

## 9. Performance Tuning

**Impact: LOW-MEDIUM**

Optimizing Redis for AI workloads. Covers index optimization, batch ingestion strategies, query optimization, memory management for large vector sets, and scaling considerations.

### 9.1 Size for Vector Workloads and Memory Footprint

**Impact: LOW-MEDIUM (prevents latency spikes from undersized clusters)**

Vector search workloads are memory intensive and can require higher vCPU for indexing and query throughput. Estimate embedding size, index overhead, and query concurrency, then select a tier/SKU that keeps memory headroom and CPU utilization below target thresholds.

**Incorrect: size only for raw document size**

```text
Dataset: 1M vectors
Tier: Memory Optimized (small)
Sizing: based only on raw embedding bytes
```

**Correct: include index overhead and query concurrency**

```text
Dataset: 1M vectors
Tier: Compute Optimized or Balanced
Sizing: raw embeddings + index overhead + 30% headroom
```

Reference: [https://learn.microsoft.com/en-us/azure/redis/overview](https://learn.microsoft.com/en-us/azure/redis/overview)

---

## References

1. [https://redis.io/docs/latest/develop/ai/](https://redis.io/docs/latest/develop/ai/)
2. [https://redis.io/docs/latest/develop/interact/search-and-query/query/vector-search/](https://redis.io/docs/latest/develop/interact/search-and-query/query/vector-search/)
3. [https://redis.io/docs/latest/develop/get-started/rag/](https://redis.io/docs/latest/develop/get-started/rag/)
4. [https://redis.io/docs/latest/integrate/redisvl/](https://redis.io/docs/latest/integrate/redisvl/)
