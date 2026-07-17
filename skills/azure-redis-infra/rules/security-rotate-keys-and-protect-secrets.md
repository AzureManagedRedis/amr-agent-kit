---
title: Rotate Access Keys and Keep Secrets Out of Code
impact: CRITICAL
impactDescription: reduces credential exposure and recovery time
tags: security, secrets, key-rotation, key-vault, access-keys
---

## Rotate Access Keys and Keep Secrets Out of Code

Prefer Microsoft Entra authentication for Azure Managed Redis. If a legacy client still requires access keys, treat the keys as break-glass credentials: store them in Key Vault or an approved secret store, reference them from managed runtime configuration, and maintain a rotation runbook that validates clients can reconnect after key changes. Never commit Redis keys, connection strings, or tokens to source control, images, IaC parameter files, or eval prompts.

**Incorrect (static key embedded in deployment artifacts):**

```text
Authentication: access key
Storage: appsettings.json committed to repo
Rotation: none
Client rollout: all instances use the same static value
Incident response: no owner or rollback plan
```

**Correct (controlled exception with rotation hygiene):**

```text
Authentication: Entra for supported clients; access key exception documented
Storage: Key Vault secret referenced by managed identity
Rotation: scheduled and tested with primary/secondary key rollover
Client rollout: staged restart or hot reload from secret reference
Incident response: owner, validation query, rollback, and audit trail
```

Reference: [Use Microsoft Entra for cache authentication](https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication), [Azure Key Vault secrets](https://learn.microsoft.com/en-us/azure/key-vault/secrets/about-secrets)
