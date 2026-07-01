---
title: Standardize One Embedding Model per Index
impact: MEDIUM
impactDescription: maintains score consistency and ranking quality
tags: embeddings, model-selection, vectors, indexing
---

## Standardize One Embedding Model per Index

A vector index should represent one embedding model/version contract. Mixing models in a single index produces inconsistent distance scores and unreliable nearest-neighbor results.

**Incorrect (mixed model vectors in one index):**

```text
kb-index contains vectors from:
- model A (1536 dim)
- model B (3072 dim)
```

**Correct (separate index per model contract):**

```text
kb-index-v1 -> model A (1536, cosine)
kb-index-v2 -> model B (3072, cosine)
```

Reference: [Redis vector best practices](https://redis.io/docs/latest/develop/ai/search-and-query/vectors/)
