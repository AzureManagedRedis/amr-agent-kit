---
title: Prefer Microsoft Entra Authentication Over Access Keys
impact: CRITICAL
impactDescription: reduces key management risk
tags: security, entra, authentication, managed-identity
---

## Prefer Microsoft Entra Authentication Over Access Keys

Azure Managed Redis supports password-free Microsoft Entra authentication and enables managed identity by default. Use Entra tokens for authentication and refresh tokens before expiry; keep access keys disabled unless a client can't support Entra.

**Incorrect (access keys only):**

```text
Authentication: Access keys enabled
Entra authentication: Disabled
Token refresh: Not implemented
```

**Correct (Entra authentication with token refresh):**

```text
Authentication: Microsoft Entra enabled
Access keys: Disabled
Client: refreshes token before expiry and re-AUTHs
```

Reference: [Use Microsoft Entra for cache authentication](https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication)
