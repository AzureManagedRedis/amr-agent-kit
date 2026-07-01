---
title: Enforce TLS 1.2+ for All Client Connections
impact: CRITICAL
impactDescription: protects data in transit
tags: security, tls, encryption, networking
---

## Enforce TLS 1.2+ for All Client Connections

Azure Managed Redis only supports TLS 1.2 and 1.3 and requires TLS by default. Do not enable non-TLS access in production; keep TLS enforced to protect data in transit and meet compliance requirements.

**Incorrect (allow non-TLS access):**

```text
Advanced settings: Non-TLS access enabled
Client port: 10000 (plaintext allowed)
```

**Correct (TLS enforced):**

```text
Advanced settings: Non-TLS access disabled
Client port: 10000 (TLS only)
```

Reference: [TLS configuration for Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/tls-configuration)
