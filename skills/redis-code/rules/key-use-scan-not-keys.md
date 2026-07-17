---
title: Use SCAN Instead of KEYS in Production
impact: CRITICAL
impactDescription: KEYS blocks the server and can cause outages
tags: keys, scan, production, performance
---

## Use SCAN Instead of KEYS in Production

Never use the KEYS command in production. It blocks Redis while scanning the entire keyspace. Use SCAN for incremental iteration instead.

**Incorrect (KEYS blocks the entire server):**

```python
import redis
r = redis.Redis(
    host='mycache.eastus.redis.azure.net',
    port=10000,
    ssl=True,
    decode_responses=True
)
# DANGER: KEYS blocks Redis until complete
# With millions of keys, this can take seconds and block all clients
all_user_keys = r.keys("user:*")

# This pattern in a request handler can cause outages
def get_all_active_users():
    keys = r.keys("session:*")  # Blocks entire Redis!
    return [r.get(k) for k in keys]

# Even with a specific pattern, KEYS scans everything
cache_keys = r.keys("cache:api:*")
```

**Correct (use SCAN for non-blocking iteration):**

```python
import redis
r = redis.Redis(
    host='mycache.eastus.redis.azure.net',
    port=10000,
    ssl=True,
    decode_responses=True
)
# SCAN iterates incrementally without blocking
def get_keys_by_pattern(pattern, count=100):
    """Non-blocking key iteration"""
    keys = []
    cursor = 0
    while True:
        cursor, batch = r.scan(cursor, match=pattern, count=count)
        keys.extend(batch)
        if cursor == 0:
            break
    return keys

# Using scan_iter helper (handles cursor automatically)
for key in r.scan_iter(match="user:*", count=100):
    process_key(key)

# Tenant/workload scoped scan for AMR DB0 key-prefix tenancy
for key in r.scan_iter(match="prod:tenant:contoso:cart:v1:*", count=1000):
    process_tenant_cart_key(key)

# Type-specific scan commands
for field, value in r.hscan_iter("myhash"):
    print(f"{field}: {value}")

for member in r.sscan_iter("myset"):
    print(member)

for member, score in r.zscan_iter("myzset"):
    print(f"{member}: {score}")

# Batch processing with SCAN
def delete_keys_by_pattern(pattern, batch_size=100):
    """Safely delete keys matching pattern"""
    cursor = 0
    deleted = 0
    while True:
        cursor, keys = r.scan(cursor, match=pattern, count=batch_size)
        if keys:
            r.delete(*keys)
            deleted += len(keys)
        if cursor == 0:
            break
    return deleted

# COUNT hint suggests batch size (not a guarantee)
# Larger COUNT = fewer round trips but longer per-call blocking
cursor, keys = r.scan(0, match="cache:*", count=1000)
```

SCAN may return duplicate keys across iterations and doesn't guarantee consistency if keys are modified during scanning. Handle duplicates in your application code. On Azure Managed Redis, use scoped prefixes such as `<env>:tenant:<tenantId>:<workload>:v<schemaVersion>:*` for tenant or workload maintenance. Do not replace unsupported `SELECT`/DB-index tenancy with broad `KEYS *` cleanup.

Reference: [SCAN Command](https://redis.io/docs/latest/commands/scan/)
