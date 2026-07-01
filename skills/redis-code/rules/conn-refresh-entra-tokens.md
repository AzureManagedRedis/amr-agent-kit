---
title: Refresh Entra Tokens Before Expiry
impact: HIGH
impactDescription: prevents authentication failures on long-lived Redis connections
tags: connection, entra, authentication, token, azure
---

## Refresh Entra Tokens Before Expiry

When using Microsoft Entra authentication with Azure Managed Redis, access tokens expire. Long-lived application processes must refresh tokens before expiry and ensure pooled connections authenticate with the fresh token. Prefer SDK-specific token credential providers where available; otherwise centralize client creation behind a refresh-aware factory.

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

**Correct (refresh-aware client factory):**

```python
import os
import time
import redis
from azure.identity import DefaultAzureCredential

class RedisClientFactory:
    def __init__(self):
        self.credential = DefaultAzureCredential()
        self.client = None
        self.refresh_at = 0

    def get_client(self):
        if self.client is None or time.time() >= self.refresh_at:
            if self.client is not None:
                self.client.close()
                self.client.connection_pool.disconnect()

            token = self.credential.get_token("https://redis.azure.com/.default")
            self.refresh_at = token.expires_on - 300
            self.client = redis.Redis(
                host=os.environ["REDIS_HOST"],
                port=10000,
                ssl=True,
                ssl_cert_reqs="required",
                username=os.environ["REDIS_ENTRA_OBJECT_ID"],
                password=token.token,
                socket_connect_timeout=5.0,
                socket_timeout=5.0,
                decode_responses=True
            )

        return self.client

redis_factory = RedisClientFactory()
```

Do not scatter token acquisition across request handlers. Keep the token refresh path coordinated with connection pooling, retry policy, and process shutdown so reconnects do not reuse expired credentials.

References:
- [Use Microsoft Entra for Redis authentication](https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication)
- [Azure Identity client library for Python](https://learn.microsoft.com/en-us/python/api/overview/azure/identity-readme)

