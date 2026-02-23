---
title: Limit K and Returned Fields for AI Retrieval
impact: HIGH
impactDescription: lowers latency and payload size for inference
tags: knn, query-shaping, latency, performance
---

## Limit K and Returned Fields for AI Retrieval

Set K based on downstream context window and return only required fields. Oversized K values and wide payloads increase query latency and token usage without improving answer quality.

**Incorrect (oversized payload):**

```text
K=200
RETURN *
```

**Correct (minimal retrieval contract):**

```text
K=8..20 (based on use case)
RETURN docId, chunkText, source, score
```

Reference: [Azure Managed Redis architecture](https://learn.microsoft.com/en-us/azure/redis/architecture)
