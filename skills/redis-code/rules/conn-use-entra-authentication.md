---
title: Use Microsoft Entra Authentication for Azure Managed Redis
impact: HIGH
impactDescription: reduces access key exposure
tags: entra, authentication, azure, security
---

## Use Microsoft Entra Authentication for Azure Managed Redis

Azure Managed Redis supports Microsoft Entra authentication with managed identities and service principals. Use Entra tokens and refresh them before expiry to avoid connection drops; keep access key authentication disabled unless a client cannot use Entra.

**Incorrect (static access keys only):**

```python
import redis

r = redis.Redis(
    host="mycache.eastus.redis.azure.net",
    port=10000,
    ssl=True,
    ssl_cert_reqs="required",
    password="PRIMARY_ACCESS_KEY"
)
```

**Correct (credential provider with automatic token refresh):**

```python
import os
from redis import RedisCluster
from redis_entraid.cred_provider import create_from_default_azure_credential

required = ["REDIS_HOST", "REDIS_PORT"]
missing = [name for name in required if not os.environ.get(name)]
if missing:
    raise RuntimeError(f"Missing Redis configuration: {', '.join(missing)}")
port = int(os.environ["REDIS_PORT"])
if not 1 <= port <= 65535:
    raise RuntimeError("REDIS_PORT must be a valid service-returned TCP port")

credential_provider = create_from_default_azure_credential(
    ("https://redis.azure.com/.default",)
)

r = RedisCluster(
    host=os.environ["REDIS_HOST"],
    port=port,
    ssl=True,
    ssl_cert_reqs="required",
    credential_provider=credential_provider,
)
```

Set `REDIS_HOST` and `REDIS_PORT` from deployment outputs; treat `10000` as the default rather than a universal port. Install `redis-entraid` and use its credential provider so the client renews tokens automatically. Match the client type to the configured cluster policy: this example uses a cluster-aware `RedisCluster` for `OSSCluster`; use the standard `Redis` client for `EnterpriseCluster` or `NoCluster`.

References:
- [Use Microsoft Entra for cache authentication](https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication)
- [Connect redis-py to Azure Managed Redis](https://redis.io/docs/latest/develop/clients/redis-py/amr/)
- [Azure Managed Redis overview](https://learn.microsoft.com/en-us/azure/redis/overview)
