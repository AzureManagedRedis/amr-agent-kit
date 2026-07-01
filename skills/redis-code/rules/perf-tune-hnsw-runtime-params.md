---
title: Tune HNSW Runtime Parameters for SLA Targets
impact: LOW-MEDIUM
impactDescription: balances latency and recall for production search
tags: hnsw, ef-runtime, latency, recall
---

## Tune HNSW Runtime Parameters for SLA Targets

Tune HNSW runtime settings (especially EF_RUNTIME) based on latency and recall requirements. Leaving defaults unchanged for every workload can miss either quality or latency targets.

**Incorrect (single static runtime setting for all workloads):**

```text
EF_RUNTIME = default for every endpoint
```

**Correct (profile and tune per endpoint class):**

```text
interactive search: EF_RUNTIME=80
analysis/offline: EF_RUNTIME=200
validate recall and p95 latency per release
```

Reference: [Redis vector indexing and query tuning](https://redis.io/docs/latest/develop/ai/search-and-query/vectors/)
