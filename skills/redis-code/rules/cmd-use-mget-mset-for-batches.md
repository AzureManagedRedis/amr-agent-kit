---
title: Use MGET/MSET for Batch Key Operations
impact: MEDIUM
impactDescription: reduces round trips for multiple key operations
tags: commands, mget, mset, batch, performance
---

## Use MGET/MSET for Batch Key Operations

Use MGET and MSET commands instead of multiple GET/SET calls when operating on multiple keys. These commands reduce network round trips and are more efficient.

**Incorrect (multiple round trips):**

```python
import redis
r = redis.Redis(
    host='mycache.eastus.redis.azure.net',
    port=10000,
    ssl=True,
    decode_responses=True
)
# Each GET is a separate round trip
user_name = r.get("user:1:name")
user_email = r.get("user:1:email")
user_status = r.get("user:1:status")

# Each SET is a separate round trip
r.set("config:timeout", "30")
r.set("config:retries", "3")
r.set("config:debug", "false")
```

**Correct (single round trip with MGET/MSET):**

```python
import redis
r = redis.Redis(
    host='mycache.eastus.redis.azure.net',
    port=10000,
    ssl=True,
    decode_responses=True
)
# Get multiple related keys in one call.
# The hash tag keeps these keys in one slot if AMR uses OSSCluster.
values = r.mget("user:{1}:name", "user:{1}:email", "user:{1}:status")
name, email, status = values

# Set multiple keys in one call
r.mset({
    "config:timeout": "30",
    "config:retries": "3",
    "config:debug": "false"
})

# MSETNX - set only if none of the keys exist
success = r.msetnx({
    "lock:resource:1": "owner:abc",
    "lock:resource:2": "owner:abc"
})

# Combine with key pattern for bulk operations
def get_user_fields(user_id, fields):
    """Get multiple user fields efficiently"""
    keys = [f"user:{{{user_id}}}:{field}" for field in fields]
    values = r.mget(keys)
    return dict(zip(fields, values))

user_data = get_user_fields(1000, ["name", "email", "created_at"])
```

MGET returns None for keys that don't exist, maintaining position in the result list. For related data, consider using hashes with HMGET/HMSET instead of separate string keys. On Azure Managed Redis with OSSCluster, MGET/MSET keys must share a hash slot or Redis can return `CROSSSLOT`; use a deliberate hash tag such as `user:{1000}:name` and `user:{1000}:email`, or prefer a single hash key when the fields belong to one object.

Reference: [MGET Command](https://redis.io/docs/latest/commands/mget/)
