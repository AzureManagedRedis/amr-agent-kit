---
title: Refresh Entra Tokens Before Expiry
impact: HIGH
impactDescription: prevents authentication failures on long-lived Redis connections
tags: connection, entra, authentication, token, azure
---

## Refresh Entra Tokens Before Expiry

When using Microsoft Entra authentication with Azure Managed Redis, access tokens expire. Long-lived application processes must refresh tokens before expiry and reauthenticate existing connections with `AUTH`. Prefer SDK-specific token credential providers that coordinate token renewal with the connection pool; do not destroy and recreate the entire pool on each refresh.

**Incorrect (token captured once at startup):**

```python
import redis
from azure.identity import DefaultAzureCredential

credential = DefaultAzureCredential()
token = credential.get_token("https://redis.azure.com/.default")

# This process may run for days, but the token will expire.
r = redis.Redis(
    host="mycache.eastus.redis.azure.net",
    port=10000,
    ssl=True,
    ssl_cert_reqs="required",
    username="managed-identity-object-id",
    password=token.token
)
```

**Correct (credential provider renews tokens for pooled connections):**

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
    socket_connect_timeout=5.0,
    socket_timeout=5.0,
    decode_responses=True,
)
```

Set `REDIS_HOST` and `REDIS_PORT` from deployment outputs; `10000` is the documented default, not the only valid database port. Install `redis-entraid` for redis-py. This example uses `RedisCluster` for `OSSCluster`; use the standard `Redis` client with the same credential provider for `EnterpriseCluster` or `NoCluster`. For clients without a supported credential provider, refresh at least three minutes before expiry, add jitter, and send `AUTH <object-id> <new-token>` on existing connections rather than dropping the pool. Instrument refresh success/failure, refresh lead time, reauthentication attempts, and downstream authentication failures.

References:
- [Use Microsoft Entra for Redis authentication](https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication)
- [Connect redis-py to Azure Managed Redis](https://redis.io/docs/latest/develop/clients/redis-py/amr/)
