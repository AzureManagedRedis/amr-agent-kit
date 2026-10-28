---
title: Enforce TLS 1.2+ for All Client Connections
impact: CRITICAL
impactDescription: protects data in transit
tags: security, tls, encryption, networking
---

## Enforce TLS 1.2+ for All Client Connections

For Azure Managed Redis, set `minimumTlsVersion` to `1.2`. Keep the database client protocol encrypted in production, and configure clients to require TLS 1.2 or later with certificate validation. The minimum-version property is separate from the negotiated wire protocol: TLS 1.2 and 1.3 are supported, but Microsoft documents no option to require clients to negotiate TLS 1.3. Because `1.2` is the only usable value (earlier enum values are obsolete), keep `minimumTlsVersion` set to `1.2` in every create and update deployment; there is no stricter minimum to move to.

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

Reference: [TLS configuration for Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/tls-configuration), [Microsoft.Cache redisEnterprise ARM template reference](https://learn.microsoft.com/en-us/azure/templates/microsoft.cache/redisenterprise)
