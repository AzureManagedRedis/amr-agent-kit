---
title: Pipeline Bulk Vector Ingestion
impact: LOW-MEDIUM
impactDescription: increases indexing throughput and lowers round-trip overhead
tags: performance, ingestion, pipelining, vectors
---

## Pipeline Bulk Vector Ingestion

Use pipelining for bulk writes during index builds and refreshes. Sending each write as a separate network round trip significantly slows ingestion at scale.

**Incorrect (one command per document):**

```python
for record in records:
    redis_client.hset(record.key, mapping=record.payload)
```

**Correct (pipeline in controlled batches):**

```python
for chunk in batched(records, 500):
    pipe = redis_client.pipeline(transaction=False)
    for record in chunk:
        pipe.hset(record.key, mapping=record.payload)
    pipe.execute()
```

Reference: [Redis pipelining](https://redis.io/docs/latest/develop/use/pipelining/)
