---
title: Use TLS and Service-Returned Azure Managed Redis Endpoints
impact: CRITICAL
impactDescription: prevents plaintext traffic and endpoint misconfiguration
tags: connection, tls, azure, security, configuration
---

## Use TLS and Service-Returned Azure Managed Redis Endpoints

Production clients for Azure Managed Redis must use the host name and port returned for that database, with TLS enabled and certificate validation on. In public Azure the default endpoint resembles `<cache-name>.<region>.redis.azure.net` and the default database port is `10000`, but additional databases can use other immutable ports and DNS suffixes vary by cloud. With `OSSCluster`, the cluster-aware client then connects directly to nodes on ports in the documented `85xx` range, which can change over time; network controls must permit them, and code must never hardcode them. Do not replace the service-returned values with local Redis defaults such as `localhost:6379`, `redis://`, `ssl=False`, disabled certificate checks, direct `privatelink` host names, or the legacy Azure Cache for Redis port `6380`.

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
if not 1 <= port <= 65535:
    raise RuntimeError("REDIS_PORT must be a valid service-returned TCP port")

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

Keep local development configuration separate from production configuration. Use `rediss://` URLs or SDK TLS options for Azure Managed Redis, keep certificate validation enabled, and fail startup if required host, port, username, or credential settings are missing. Pair TLS setup with a singleton client or pool, explicit timeouts, bounded retries with jitter, and Entra token refresh when using identity-based authentication. Treat `10000` as the default database port, not a universal constant: consume the service-returned value and follow cluster redirects rather than hardcoding direct-node ports.

References:
- [Azure Managed Redis architecture](https://learn.microsoft.com/en-us/azure/redis/architecture)
- [Redis TLS documentation](https://redis.io/docs/latest/operate/oss_and_stack/management/security/encryption/)
