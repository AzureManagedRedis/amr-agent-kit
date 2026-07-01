---
title: Use Bounded Retries with Jitter
impact: HIGH
impactDescription: reduces cascading failures during transient Redis outages
tags: resilience, retry, backoff, timeout, idempotency
---

## Use Bounded Retries with Jitter

Retry transient Redis connection and timeout failures with a small maximum attempt count, exponential backoff, jitter, and an overall operation deadline. Never use infinite retry loops or immediate retry storms; they amplify Azure Managed Redis failovers, network blips, and throttling.

**Incorrect (unbounded immediate retries):**

```python
import redis

r = redis.Redis(host="mycache.eastus.redis.azure.net", port=10000, ssl=True)

def get_cached_user(user_id):
    while True:
        try:
            return r.get(f"cache:user:{user_id}")
        except redis.RedisError:
            # Busy loop hammers Redis and can block the request forever.
            continue
```

**Correct (bounded retries with jitter and fallback):**

```python
import random
import time
import redis

r = redis.Redis(
    host="mycache.eastus.redis.azure.net",
    port=10000,
    ssl=True,
    socket_connect_timeout=5.0,
    socket_timeout=5.0,
    decode_responses=True
)

TRANSIENT_ERRORS = (redis.ConnectionError, redis.TimeoutError)

def get_cached_user(user_id):
    delay = 0.1

    for attempt in range(3):
        try:
            return r.get(f"cache:user:{user_id}")
        except TRANSIENT_ERRORS:
            if attempt == 2:
                return None

            sleep_for = min(delay + random.uniform(0, delay), 2.0)
            time.sleep(sleep_for)
            delay *= 2
```

Use SDK retry mechanisms when they provide equivalent controls, but still set socket and command timeouts. Only retry operations that are safe to replay; for Lua scripts, transactions, counters, and queue acknowledgements, design idempotency keys or use application-level reconciliation before retrying blindly.

References:
- [Redis client error handling](https://redis.io/docs/latest/develop/clients/error-handling/)
- [Azure Well-Architected reliability recommendations](https://learn.microsoft.com/en-us/azure/well-architected/reliability/)

