---
title: Use Colons for Key Namespacing
impact: CRITICAL
impactDescription: enables organized keyspace and efficient scanning
tags: keys, naming, namespacing, conventions
---

## Use Colons for Key Namespacing

Use colon-separated hierarchical key names to organize your keyspace. This convention is widely adopted and enables efficient key scanning and management. Azure Managed Redis uses the `default` database, so model logical databases, tenants, environments, and workloads with explicit key prefixes rather than Redis DB indexes.

**Incorrect (inconsistent or flat naming):**

```python
import redis
r = redis.Redis(
    host='mycache.eastus.redis.azure.net',
    port=10000,
    ssl=True,
    decode_responses=True
)
# Flat, inconsistent naming - hard to manage
r.set("user1name", "John")
r.set("user_1_email", "john@example.com")
r.set("1-user-age", "30")
r.set("sessionabc123", "data")

# No way to efficiently find all user keys
# KEYS * would return everything
```

**Correct (hierarchical colon-separated naming):**

```python
import redis
r = redis.Redis(
    host='mycache.eastus.redis.azure.net',
    port=10000,
    ssl=True,
    decode_responses=True
)
# Consistent hierarchical naming: object-type:id:field
r.set("user:1000:name", "John")
r.set("user:1000:email", "john@example.com")
r.hset("user:1000:profile", mapping={"age": "30", "city": "NYC"})

# Session keys with clear namespace
r.set("session:abc123:data", "session_data")
r.set("session:abc123:user_id", "1000")

# Cache keys with clear purpose and schema/data version
r.set("cache:api:v1:users:list", cached_response, ex=900)
r.set("cache:db:v2:query:hash123", cached_result, ex=900)

# Rate limiting keys
r.set("ratelimit:api:user:1000", "5")

# Logical database or tenant separation through prefixes
r.set("tenant:contoso:session:abc123", session_payload, ex=3600)
r.set("tenant:fabrikam:session:def456", other_session_payload, ex=3600)

# Scan for all user keys efficiently
cursor = 0
while True:
    cursor, keys = r.scan(cursor, match="user:*", count=100)
    for key in keys:
        print(key)
    if cursor == 0:
        break

# Scan for all sessions
for key in r.scan_iter(match="session:*"):
    print(key)
```

The colon convention is not enforced by Redis but is a widely adopted standard. It makes keys self-documenting and enables pattern-based operations with SCAN. For Azure Managed Redis, keep application data in database 0 and use prefixes such as `tenant:{tenantId}:`, `env:prod:`, or `cache:catalog:v2:` for logical separation. For caches, include a version segment such as `v1` or a data-contract version so deploys and schema changes can invalidate safely without broad deletes.

Reference: [Redis Keys](https://redis.io/docs/latest/develop/use/keyspace/)
