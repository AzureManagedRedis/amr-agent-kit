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
from redis import RedisCluster
from redis_entraid.cred_provider import create_from_default_azure_credential

credential_provider = create_from_default_azure_credential(
    ("https://redis.azure.com/.default",)
)

r = RedisCluster(
    host="mycache.eastus.redis.azure.net",
    port=10000,
    ssl=True,
    ssl_cert_reqs="required",
    credential_provider=credential_provider,
)
```

Install `redis-entraid` and use its credential provider so the client renews tokens automatically. Match the client type to the configured cluster policy: use a cluster-aware client such as `RedisCluster` for `OSSCluster`, and the standard `Redis` client for `EnterpriseCluster` or `NoCluster`.

References:
- [Use Microsoft Entra for cache authentication](https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication)
- [Connect redis-py to Azure Managed Redis](https://redis.io/docs/latest/develop/clients/redis-py/amr/)
- [Azure Managed Redis overview](https://learn.microsoft.com/en-us/azure/redis/overview)
