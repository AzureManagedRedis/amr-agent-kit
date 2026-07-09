---
title: Keep Embedding Dimensions and Distance Metric Aligned
impact: CRITICAL
impactDescription: prevents query failures and relevance degradation
tags: vectors, dimensions, cosine, hnsw
---

## Keep Embedding Dimensions and Distance Metric Aligned

Each vector index must use a single embedding model, dimension, and distance metric aligned with the selected model. Mixing dimensions or changing metrics without rebuilding the index causes runtime errors or poor ranking quality. When designing RAG or semantic cache indexes, name the full index contract in the answer: embedding model/version, vector dimension, distance metric, and the re-embed or new-index plan for model changes.

**Incorrect (mixed model dimensions in one index):**

```text
Index DIM=1536
Inserted vectors: [1536, 1536, 3072]
Query result: dimension mismatch errors
```

**Correct (one model configuration per index):**

```text
index: kb-v1
model: text-embedding-3-small
dimension: 1536
metric: COSINE
```

Reference: [Redis vector index configuration](https://redis.io/docs/latest/develop/ai/search-and-query/vectors/)
