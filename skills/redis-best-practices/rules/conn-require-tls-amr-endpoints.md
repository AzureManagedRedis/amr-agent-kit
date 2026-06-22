---
title: Use TLS and Azure Managed Redis Ports
impact: CRITICAL
impactDescription: prevents plaintext traffic and endpoint misconfiguration
tags: connection, tls, azure, security, configuration
---

## Use TLS and Azure Managed Redis Ports

Production clients for Azure Managed Redis must connect to the managed endpoint with TLS enabled and certificate validation on. Do not copy local Redis defaults such as `localhost:6379`, `redis://`, `ssl=False`, or disabled certificate checks into production configuration.

**Incorrect (local/non-TLS defaults used for AMR):**

```python
import redis

r = redis.Redis(
    host="mycache.eastus.redis.azure.net",
    port=6379,
    ssl=False,
    password="access-key",
    ssl_cert_reqs=None
)

r.set("cache:ready", "true")
```

**Correct (AMR endpoint with TLS and validation):**

```python
import os
import redis

r = redis.Redis(
    host=os.environ["REDIS_HOST"],
    port=int(os.environ.get("REDIS_PORT", "10000")),
    ssl=True,
    ssl_cert_reqs="required",
    username=os.environ["REDIS_USERNAME"],
    password=os.environ["REDIS_PASSWORD"],
    socket_connect_timeout=5.0,
    socket_timeout=5.0,
    decode_responses=True
)

r.set("cache:ready", "true", ex=60)
```

Keep local development configuration separate from production configuration. Use `rediss://` URLs or SDK TLS options for Azure Managed Redis, keep certificate validation enabled, and fail startup if required host, port, username, or credential settings are missing.

References:
- [Azure Managed Redis architecture](https://learn.microsoft.com/en-us/azure/redis/architecture)
- [Redis TLS documentation](https://redis.io/docs/latest/operate/oss_and_stack/management/security/encryption/)

