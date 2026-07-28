---
title: Enforce TLS 1.2+ for All Client Connections
impact: CRITICAL
impactDescription: protects data in transit
tags: security, tls, encryption, networking
---

## Enforce TLS 1.2+ for All Client Connections

For Azure Managed Redis, set `minimumTlsVersion` to `1.2`; it is the only accepted control-plane value and cannot be changed after creation. Keep the database client protocol encrypted in production, and configure clients to require TLS 1.2 or later with certificate validation. Do not set `minimumTlsVersion` to `1.3`: whether a connection negotiates a newer wire protocol is separate from the minimum-version property.

**Incorrect (allow non-TLS access):**

```text
minimumTlsVersion: 1.3
clientProtocol: Plaintext
```

**Correct (TLS enforced):**

```text
minimumTlsVersion: 1.2
clientProtocol: Encrypted
Client: TLS with certificate validation
```

Reference: [TLS configuration for Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/tls-configuration)
