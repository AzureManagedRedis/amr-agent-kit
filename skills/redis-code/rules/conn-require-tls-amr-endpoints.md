---
title: Use TLS and Azure Managed Redis Ports
impact: CRITICAL
impactDescription: prevents plaintext traffic and endpoint misconfiguration
tags: connection, tls, azure, security, configuration
---

## Use TLS and Azure Managed Redis Ports

Production clients for Azure Managed Redis must connect to the normal managed endpoint, for example `<cache-name>.<region>.redis.azure.net`, on port `10000` with TLS enabled and certificate validation on. Do not copy local Redis defaults such as `localhost:6379`, `redis://`, `ssl=False`, disabled certificate checks, direct `privatelink` host names, or Azure Cache for Redis port `6380` into production configuration.

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

required = ["REDIS_HOST", "REDIS_PORT", "REDIS_USERNAME", "REDIS_PASSWORD"]
missing = [name for name in required if not os.environ.get(name)]
if missing:
    raise RuntimeError(f"Missing Redis configuration: {', '.join(missing)}")

port = int(os.environ["REDIS_PORT"])
if port != 10000:
    raise RuntimeError("Azure Managed Redis production clients should use port 10000")

r = redis.Redis(
    host=os.environ["REDIS_HOST"],
    port=port,
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

Keep local development configuration separate from production configuration. Use `rediss://` URLs or SDK TLS options for Azure Managed Redis, keep certificate validation enabled, and fail startup if required host, port, username, or credential settings are missing. Pair TLS setup with a singleton client or pool, explicit timeouts, bounded retries with jitter, and Entra token refresh when using identity-based authentication. When reviewing production code, explicitly reject port `6380`; it belongs to the legacy Azure Cache for Redis pattern, not Azure Managed Redis.

References:
- [Azure Managed Redis architecture](https://learn.microsoft.com/en-us/azure/redis/architecture)
- [Redis TLS documentation](https://redis.io/docs/latest/operate/oss_and_stack/management/security/encryption/)
