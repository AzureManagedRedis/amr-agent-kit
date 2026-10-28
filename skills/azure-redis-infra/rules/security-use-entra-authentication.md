---
title: Prefer Microsoft Entra Authentication Over Access Keys
impact: CRITICAL
impactDescription: reduces key management risk
tags: security, entra, authentication, managed-identity
---

## Prefer Microsoft Entra Authentication Over Access Keys

Azure Managed Redis uses Microsoft Entra authentication by default, and managed identity is enabled when you create a new cache. To authorize a workload, add its managed identity or service principal to the cache's Redis users list. By default, Redis users receive full access to all commands and keys; use custom data access permissions where supported to restrict access. Refresh Entra tokens before expiry and keep access keys disabled unless a client cannot support Entra. The public documentation does not specify the exact ARM resource identity type when it describes this default.

**Incorrect (access keys only):**

```text
Authentication: Access keys enabled
Entra authentication: Disabled
Token refresh: Not implemented
```

**Correct (Entra authentication with token refresh):**

```text
Authentication: Microsoft Entra enabled
Workload managed identity or service principal: added to Redis users
Custom data access permissions: restricted to required commands and keys
Access keys: Disabled
Client: refreshes token before expiry and re-AUTHs
```

Changing the access-key authentication setting terminates all current connections, including Entra-authenticated connections. Schedule the change, verify bounded reconnect behavior first, and monitor recovery. For geo-replicated caches, follow the current sequence in [Disable access key authentication on your cache](https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication#disable-access-key-authentication-on-your-cache) rather than treating the setting as an independent in-place update.

Reference: [Use Microsoft Entra for cache authentication](https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication), [Configure custom data access permissions](https://learn.microsoft.com/en-us/azure/redis/configure-access-permissions)
