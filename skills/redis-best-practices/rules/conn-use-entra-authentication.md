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
    password="PRIMARY_ACCESS_KEY"
)
```

**Correct (Entra token with refresh):**

```python
# Use an Entra token as the password and refresh before expiry.
# In production, use a client library that manages token refresh.
import redis
from azure.identity import DefaultAzureCredential

credential = DefaultAzureCredential()
token = credential.get_token("https://redis.azure.com/.default")

r = redis.Redis(
    host="mycache.eastus.redis.azure.net",
    port=10000,
    ssl=True,
    username="<object-id>",
    password=token.token
)
```

Reference: [Use Microsoft Entra for cache authentication](https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication)
