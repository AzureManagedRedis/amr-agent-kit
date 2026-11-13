---
title: Invalidate Semantic Cache on Knowledge and Policy Changes
impact: HIGH
impactDescription: avoids serving stale or unauthorized generated answers
tags: semantic-cache, invalidation, ttl, versioning, safety
---

## Invalidate Semantic Cache on Knowledge and Policy Changes

Refresh scope when knowledge, entitlements, policy, prompts, or models change. Store the complete scope as indexed TAG fields and require it in every lookup; version strings in key names and TTL alone do not prevent stale reuse.

**Incorrect (cache namespace ignores knowledge and policy versions):**

```python
cache_key = f"semcache:{tenant_id}:{model_id}:{prompt_version}:{query_hash}"
redis_client.hset(cache_key, mapping={"answer": answer, "embedding": query_embedding})
redis_client.expire(cache_key, 86400)
```

**Correct (decode current versions, reject missing scope, and filter reuse):**

Inputs come from trusted request/configuration context. `redis_client` uses TLS/authentication, and `vectorizer` matches `embedding_model`. Initialize the cache once with the shown TAG schema.

```python
from functools import reduce
from hashlib import sha256
from operator import and_

from redisvl.extensions.cache.llm import SemanticCache
from redisvl.query.filter import Tag

if not isinstance(tenant_id, str) or not tenant_id.strip():
    raise ValueError("tenant context is required before reading cache versions")
scope = {
    "tenant_id": tenant_id, "acl_hash": acl_hash,
    "llm_model": llm_model, "embedding_model": embedding_model,
    "prompt_version": prompt_version,
    "kb_version": redis_client.get(f"rag:corpus_version:{tenant_id}:support_kb"),
    "policy_version": redis_client.get(f"ai:policy_version:{tenant_id}"),
}
for name, value in scope.items():
    if name in ("kb_version", "policy_version") and isinstance(value, bytes):
        value = value.decode("utf-8", errors="strict")
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"missing or invalid semantic-cache scope: {name}")
    scope[name] = value
# Hex tokens avoid TAG separators and query syntax in scope values.
filters = {name: sha256(value.encode("utf-8")).hexdigest() for name, value in scope.items()}
required = reduce(and_, (Tag(name) == value for name, value in filters.items()))
cache = SemanticCache(
    name="semcache_scoped_v2", redis_client=redis_client, vectorizer=vectorizer,
    distance_threshold=0.1, ttl=900,
    filterable_fields=[{"name": name, "type": "tag"} for name in scope],
)
hits = cache.check(prompt=question, filter_expression=required)
if hits:
    answer = hits[0]["response"]
else:
    answer = generate_authorized_answer(question)
    cache.store(prompt=question, response=answer, filters=filters)
```

Default redis-py responses are bytes: decode them, never interpolate `b'17'` or convert a missing value to `"None"`. Missing or malformed versions stop cache reads and writes. Initialize version markers through deployment, not request-time defaults.

Publish new, non-reused versions when knowledge/policy changes are ready, and refresh the effective ACL hash when entitlements change. New requests then exclude older entries, which can expire by TTL. Keep the captured scope on an in-flight answer; never relabel it with newer versions. Immediate revocation also requires reauthorization before returning a hit or generated answer.

This uses RedisVL's client-side API with RediSearch enabled on a supported AMR configuration. For multiple knowledge bases, include their identities/versions instead of sharing the fixed `support_kb` marker. Never recover from a scope error by omitting filters.

References: [AMR semantic-cache tutorial](https://learn.microsoft.com/en-us/azure/redis/tutorial-semantic-cache); [RedisVL SemanticCache API](https://docs.redisvl.com/en/stable/api/cache.html)
