---
title: Use Hybrid Vector Search with Metadata Filters
impact: CRITICAL
impactDescription: improves retrieval precision and prevents unsafe post-filtering
tags: vector-search, hybrid-search, metadata, filtering, rag
---

## Use Hybrid Vector Search with Metadata Filters

Combine vector similarity with metadata filters in the Redis query itself. Pulling broad top-K results and filtering in application code can drop relevant results, increase latency, and expose records from the wrong tenant, locale, status, or entitlement boundary.

**Incorrect (filtering after broad vector retrieval):**

```python
query = Query("*=>[KNN 50 @embedding $vec AS score]").sort_by("score")
results = redis_client.ft("idx:kb").search(query, {"vec": query_vector})

allowed = [
    doc for doc in results.docs
    if doc.tenant_id == tenant_id
    and doc.locale == locale
    and doc.access_tier in user_access_tiers
]
```

**Correct (hybrid filter and vector search in one query):**

```python
tenant = escape_tag(tenant_id)
locale_tag = escape_tag(locale)
access = "|".join(escape_tag(tier) for tier in user_access_tiers)

filter_expr = (
    f"(@tenant_id:{{{tenant}}} @locale:{{{locale_tag}}} "
    f"@access_tier:{{{access}}} @status:{{active}})"
)
query = (
    Query(f"{filter_expr}=>[KNN 8 @embedding $vec AS score]")
    .sort_by("score")
    .return_fields("chunk_id", "title", "source_url", "score")
)

results = redis_client.ft("idx:kb").search(query, {"vec": query_vector})
```

Reference: [Redis vector search](https://redis.io/docs/latest/develop/ai/search-and-query/vectors/)
