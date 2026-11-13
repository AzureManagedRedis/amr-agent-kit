---
title: Scope Semantic Cache Reuse by Tenant, Model, and Version
impact: HIGH
impactDescription: prevents cross-tenant or incompatible cached answer reuse
tags: semantic-cache, tenant-isolation, acl, model-version, prompt-version
---

## Scope Semantic Cache Reuse by Tenant, Model, and Version

Key names do not restrict vector search across a shared index. Store tenant, effective ACL hash, model IDs, and versions as indexed TAG fields, and require all of them as prefilters on every lookup. Reject missing scope before either reads or writes.

**Incorrect (scoped keys, but an unfiltered search across the shared index):**

```python
cache_key = f"semcache:{tenant_id}:{model_id}:{prompt_version}:{query_hash}"
hits = cache.check(prompt=question)  # Key naming does not constrain this search.
```

**Correct (store the complete scope and AND every field in the lookup):**

Inputs come from authenticated server-side context and the actual generation configuration. `acl_hash` identifies effective entitlements, including user/session identity for personalized answers.

```python
from functools import reduce
from hashlib import sha256
from operator import and_

from redisvl.extensions.cache.llm import SemanticCache
from redisvl.query.filter import Tag

scope = {
    "tenant_id": tenant_id, "acl_hash": acl_hash,
    "llm_model": llm_model, "embedding_model": embedding_model,
    "prompt_version": prompt_version, "kb_version": kb_version,
    "policy_version": policy_version,
}
for name, value in scope.items():
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"missing or invalid semantic-cache scope: {name}")
# Hex tokens preserve exact equality without TAG separators or query syntax.
filters = {name: sha256(value.encode("utf-8")).hexdigest() for name, value in scope.items()}
required = reduce(and_, (Tag(name) == value for name, value in filters.items()))

# Initialize once; redis_client uses TLS/authentication and vectorizer matches embedding_model.
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

Use RedisVL's client-side `SemanticCache` API with RediSearch enabled on a supported AMR configuration. The example uses a new index so legacy entries without scope are not reused. Tune the example TTL and Redis COSINE-distance threshold for the workload; neither replaces filtering.

Never retry a failed lookup without filters or substitute a default tenant. Hashing provides literal equality tokens, not authorization. Capture scope for each request and keep it attached to the generated answer.

References: [AMR semantic-cache tutorial](https://learn.microsoft.com/en-us/azure/redis/tutorial-semantic-cache); [RedisVL SemanticCache API](https://docs.redisvl.com/en/stable/api/cache.html)
