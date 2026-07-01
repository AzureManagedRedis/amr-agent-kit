---
title: Size for Vector Workloads and Memory Footprint
impact: LOW-MEDIUM
impactDescription: prevents latency spikes from undersized clusters
tags: sizing, vectors, memory, performance
---

## Size for Vector Workloads and Memory Footprint

Vector search workloads are memory intensive and can require higher vCPU for indexing and query throughput. Estimate embedding size, index overhead, and query concurrency, then select a tier/SKU that keeps memory headroom and CPU utilization below target thresholds.

**Incorrect (size only for raw document size):**

```text
Dataset: 1M vectors
Tier: Memory Optimized (small)
Sizing: based only on raw embedding bytes
```

**Correct (include index overhead and query concurrency):**

```text
Dataset: 1M vectors
Tier: Compute Optimized or Balanced
Sizing: raw embeddings + index overhead + 30% headroom
```

Reference: [Azure Managed Redis overview](https://learn.microsoft.com/en-us/azure/redis/overview)
