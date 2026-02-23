---
title: Use RedisVL for Index Schema and Query Lifecycle
impact: MEDIUM
impactDescription: reduces schema drift and integration errors
tags: redisvl, integration, schema, vector-index
---

## Use RedisVL for Index Schema and Query Lifecycle

Use RedisVL to define index schema, create indexes, and run vector queries consistently. Hand-written command strings are harder to maintain and often drift from application model definitions.

**Incorrect (manual command strings across services):**

```python
redis_client.execute_command("FT.CREATE idx ...")
redis_client.execute_command("FT.SEARCH idx ...")
```

**Correct (RedisVL-managed schema and querying):**

```python
from redisvl.index import SearchIndex

index = SearchIndex.from_dict(schema_dict)
index.create(overwrite=False)
results = index.query(query)
```

Reference: [RedisVL documentation](https://redis.io/docs/latest/develop/ai/redisvl/)
