---
title: Batch Embedding Generation and Redis Upserts
impact: MEDIUM
impactDescription: improves ingestion throughput and reduces cost
tags: embeddings, batching, upsert, ingestion
---

## Batch Embedding Generation and Redis Upserts

Generate embeddings in batches and pipeline Redis writes during indexing. Per-document embedding calls and single-command writes increase ingestion time and API overhead.

**Incorrect (single-document ingestion loop):**

```python
for doc in docs:
    vec = embed([doc])[0]
    redis_client.hset(f"doc:{doc.id}", mapping={"embedding": vec})
```

**Correct (batched embedding + pipelined writes):**

```python
for batch in batched(docs, 128):
    vectors = embed([d.text for d in batch])
    pipe = redis_client.pipeline(transaction=False)
    for doc, vec in zip(batch, vectors):
        pipe.hset(f"doc:{doc.id}", mapping={"embedding": vec, "title": doc.title})
    pipe.execute()
```

Reference: [Redis pipelining](https://redis.io/docs/latest/develop/use/pipelining/)
