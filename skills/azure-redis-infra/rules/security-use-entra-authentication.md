---
title: Prefer Microsoft Entra Authentication Over Access Keys
impact: CRITICAL
impactDescription: reduces key management risk
tags: security, entra, authentication, managed-identity
---

## Prefer Microsoft Entra Authentication Over Access Keys

Azure Managed Redis supports password-free Microsoft Entra authentication, but identity configuration is explicit rather than automatic. Assign a managed identity or service principal to the workload, create the corresponding AMR data access policy assignment, and refresh Entra tokens before expiry. The cache resource's own managed identity defaults to `None` and is separate from the workload identity used for data-plane authentication. Keep access keys disabled unless a client cannot support Entra.

**Incorrect (access keys only):**

```text
Authentication: Access keys enabled
Entra authentication: Disabled
Token refresh: Not implemented
```

**Correct (Entra authentication with token refresh):**

```text
Authentication: Microsoft Entra enabled
Workload identity: explicitly assigned
AMR data access policy: scoped to the workload identity
Access keys: Disabled
Client: refreshes token before expiry and re-AUTHs
```

Reference: [Use Microsoft Entra for cache authentication](https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication)
