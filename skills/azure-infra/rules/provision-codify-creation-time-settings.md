---
title: Codify Creation-Time Settings in Infrastructure as Code
impact: CRITICAL
impactDescription: prevents drift and disruptive reprovisioning
tags: provisioning, iac, bicep, terraform, what-if, drift
---

## Codify Creation-Time Settings in Infrastructure as Code

Azure Managed Redis choices such as tier/SKU, region, modules, cluster policy, high availability, active geo-replication, private connectivity, diagnostics, and access policies should be modeled before deployment. Use Bicep, Azure Verified Modules, or Terraform modules with parameters per environment, and review changes with `what-if`, `terraform validate`, and `terraform plan` before applying. Portal-only deployments hide creation-time decisions and increase drift.

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
Parameters: tier, SKU, region, modules, cluster policy, HA, zones
Networking: private endpoint, publicNetworkAccess, DNS links
Security: Entra users, access policies, TLS, key posture
Preflight: az deployment what-if or terraform validate && terraform plan
Operations: diagnostic settings and alerts deployed with the cache
```

Reference: [Azure Managed Redis ARM templates](https://learn.microsoft.com/en-us/azure/templates/microsoft.cache/redisenterprise), [Create Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/quickstart-create-managed-redis)
