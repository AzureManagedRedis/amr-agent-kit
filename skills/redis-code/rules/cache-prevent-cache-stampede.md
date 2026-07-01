---
title: Prevent Cache Stampede
impact: HIGH
impactDescription: avoids database overload when cache expires
tags: caching, stampede, thundering-herd, locking
---

## Prevent Cache Stampede

Prevent cache stampede (thundering herd) when a popular cache key expires and many requests simultaneously try to regenerate it. Use locking or probabilistic early expiration.

**Incorrect (all requests hit database on expiration):**

```python
import redis
import json
r = redis.Redis(
    host='mycache.eastus.redis.azure.net',
    port=10000,
    ssl=True,
    decode_responses=True
)
def get_popular_data():
    cached = r.get("cache:popular")
    if cached:
        return json.loads(cached)

    # When cache expires, ALL concurrent requests hit the database
    data = expensive_database_query()
    r.set("cache:popular", json.dumps(data), ex=300)
    return data
```

**Correct (use distributed lock for cache rebuild):**

```python
import redis
import json
import time
import random
import uuid
r = redis.Redis(
    host='mycache.eastus.redis.azure.net',
    port=10000,
    ssl=True,
    decode_responses=True
)
def get_with_lock(cache_key, ttl, fetch_func):
    """Cache-aside with lock to prevent stampede"""
    cached = r.get(cache_key)
    if cached:
        return json.loads(cached)

    lock_key = f"lock:{cache_key}"
    lock_token = str(uuid.uuid4())

    # Try to acquire lock
    if r.set(lock_key, lock_token, nx=True, ex=30):  # 30s lock timeout
        try:
            # We have the lock - fetch and cache
            data = fetch_func()
            r.set(cache_key, json.dumps(data), ex=ttl + random.randint(0, max(1, ttl // 10)))
            return data
        finally:
            r.eval(
                """
                if redis.call("GET", KEYS[1]) == ARGV[1] then
                    return redis.call("DEL", KEYS[1])
                end
                return 0
                """,
                1,
                lock_key,
                lock_token,
            )
    else:
        # Another process is rebuilding - wait and retry
        for _ in range(10):
            time.sleep(0.1)
            cached = r.get(cache_key)
            if cached:
                return json.loads(cached)

        # Fallback: fetch anyway if lock holder failed
        return fetch_func()

# Probabilistic early expiration (XFetch algorithm)
def get_with_early_expiration(cache_key, ttl, fetch_func, beta=1.0):
    """Refresh cache before expiration probabilistically"""
    cached = r.get(cache_key)
    remaining_ttl = r.ttl(cache_key)

    if cached and remaining_ttl > 0:
        # Probabilistic early recompute
        # Higher probability as expiration approaches
        delta = ttl - remaining_ttl
        should_recompute = random.random() < (delta / ttl) * beta

        if not should_recompute:
            return json.loads(cached)

    # Recompute and cache
    data = fetch_func()
    r.set(cache_key, json.dumps(data), ex=ttl + random.randint(0, max(1, ttl // 10)))
    return data

# Background refresh pattern
def get_with_background_refresh(cache_key, ttl, stale_threshold, fetch_func):
    """Serve stale data while refreshing in background"""
    cached = r.get(cache_key)
    remaining_ttl = r.ttl(cache_key)

    if cached:
        data = json.loads(cached)

        # If approaching expiration, trigger background refresh
        if remaining_ttl < stale_threshold:
            trigger_background_refresh(cache_key, ttl, fetch_func)

        return data

    # No cache - must fetch synchronously
    data = fetch_func()
    r.set(cache_key, json.dumps(data), ex=ttl + random.randint(0, max(1, ttl // 10)))
    return data
```

For high-traffic cache keys, use namespaced and versioned keys such as `cache:catalog:v1:product:{sku}`. Use distributed locking so only one request regenerates the cache, and release locks only when the stored token matches the holder. Probabilistic early expiration and TTL jitter spread regeneration over time instead of at exact expiration.

Reference: [Cache Stampede Prevention](https://redis.io/glossary/cache-stampede/)
