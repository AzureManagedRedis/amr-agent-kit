---
title: Codify Creation-Time Settings in Infrastructure as Code
impact: CRITICAL
impactDescription: prevents drift and disruptive reprovisioning
tags: provisioning, iac, bicep, terraform, what-if, drift
---

## Codify Creation-Time Settings in Infrastructure as Code

Azure Managed Redis choices such as tier/SKU, region, modules, cluster policy, high availability, active geo-replication, protocol mode, persistence, private endpoint, private DNS zone links, public network access, diagnostics, and access policies should be modeled before deployment. Use Bicep, Azure Verified Modules, or Terraform modules with parameters per environment, and review changes with `what-if`, `terraform validate`, and `terraform plan` before applying. Portal-only deployments hide creation-time decisions and increase drift.

**Incorrect (manual deployment with deferred decisions):**

```text
Provisioning: portal click-through
Tier/SKU: smallest available
Modules: decide after go-live
Cluster policy: decide after clients are built
Networking/Security/Diagnostics: manual follow-up tasks
Preflight: no what-if or plan review
```

**Correct (repeatable IaC baseline):**

```text
IaC: Bicep/AVM or Terraform module checked into source control
Parameters: tier, SKU, region, modules, cluster policy, HA, protocol, persistence
Networking: private endpoint, publicNetworkAccess, DNS links
Security: Entra users, access policies, TLS, key posture
Database: default database, configured port (10000 by default), clientProtocol, evictionPolicy
Preflight: az deployment what-if or terraform validate && terraform plan
Operations: diagnostic settings and alerts deployed with the cache
```

When generating IaC, prefer the native AMR resource model in `provision-use-native-amr-iac`: ARM/Bicep uses a cluster resource plus a `default` database child, while Terraform uses `azurerm_managed_redis` with an inline `default_database` block. Include creation-time choices as explicit parameters so review can catch risky defaults before deployment.

Reference: [Azure Managed Redis ARM templates](https://learn.microsoft.com/en-us/azure/templates/microsoft.cache/redisenterprise), [Create Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/quickstart-create-managed-redis)
