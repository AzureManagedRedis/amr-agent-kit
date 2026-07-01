---
title: Invalidate Semantic Cache on Knowledge and Policy Changes
impact: HIGH
impactDescription: avoids serving stale or unauthorized generated answers
tags: semantic-cache, invalidation, ttl, versioning, safety
---

## Invalidate Semantic Cache on Knowledge and Policy Changes

Semantic cache entries depend on more than the query embedding. Invalidate or version the cache when source knowledge, entitlement rules, safety policy, prompt templates, or model versions change. TTL alone is not enough for urgent corrections or access-policy updates.

**Incorrect (cache namespace ignores knowledge and policy versions):**

```python
cache_key = f"semcache:{tenant_id}:{model_id}:{prompt_version}:{query_hash}"
redis_client.hset(cache_key, mapping={"answer": answer, "embedding": query_embedding})
redis_client.expire(cache_key, 86400)
```

**Correct (include corpus and policy versions in the reuse contract):**

```python
corpus_version = redis_client.get(f"rag:corpus_version:{tenant_id}:support_kb")
policy_version = redis_client.get(f"ai:policy_version:{tenant_id}")

cache_key = (
    f"semcache:{tenant_id}:{model_id}:{prompt_version}:"
    f"{corpus_version}:{policy_version}:{query_hash}"
)
redis_client.hset(cache_key, mapping={
    "answer": answer,
    "embedding": query_embedding,
    "corpus_version": corpus_version,
    "policy_version": policy_version,
})
redis_client.expire(cache_key, ttl_seconds)
```

Reference: [RedisVL for AI application patterns](https://redis.io/docs/latest/develop/ai/redisvl/)
