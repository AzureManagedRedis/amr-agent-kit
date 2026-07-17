---
title: Tune Semantic Cache Threshold and TTL by Use Case
impact: HIGH
impactDescription: balances reuse rate with response correctness
tags: semantic-cache, threshold, ttl, llm
---

## Tune Semantic Cache Threshold and TTL by Use Case

Semantic cache effectiveness depends on similarity threshold and TTL strategy. A single global threshold is usually suboptimal; tune by domain criticality and data volatility.

**Incorrect (one global setting for all workloads):**

```text
similarity_threshold=0.99
ttl=30 days
```

**Correct (domain-specific cache policy):**

```text
FAQ bot: threshold=0.85, ttl=24h
Policy assistant: threshold=0.93, ttl=2h
Trading insights: threshold=0.95, ttl=5m
```

Reference: [Redis AI patterns](https://redis.io/docs/latest/develop/ai/)
