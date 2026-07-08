---
title: Choose Cluster Policy Based on Client and Module Needs
impact: MEDIUM
impactDescription: prevents client incompatibility and throughput bottlenecks
tags: performance, cluster-policy, oss, enterprise, modules
---

## Choose Cluster Policy Based on Client and Module Needs

Azure Managed Redis supports OSSCluster, EnterpriseCluster, and NoCluster policies. Choose the policy explicitly based on client capabilities, module requirements, cache size, and multi-key command behavior; do not rely on provider defaults. AMR manages partitioning internally, so avoid describing the service in terms of customer-managed shard counts.

**Incorrect (select OSS when clients and modules require Enterprise):**

```text
Cluster policy: OSSCluster
Client library: not Redis Cluster-aware
Modules: RediSearch enabled
Multi-key/Lua: uses keys across slots
```

**Correct (align policy with client/module requirements):**

```text
Cluster policy: NoCluster when supported for simple single-endpoint workloads
Cluster policy: OSSCluster only for Redis Cluster-aware clients
Cluster policy: EnterpriseCluster when required by modules or client compatibility
Multi-key/Lua: keys use hash tags or avoid cross-slot operations
```

Prefer `NoCluster` when the workload fits its supported size and needs single-endpoint semantics with the least CROSSSLOT risk. Use `OSSCluster` only when clients are cluster-aware and operational runbooks account for cluster topology. Use `EnterpriseCluster` when module support or client compatibility requires it, while still checking multi-key commands and Lua scripts for cross-slot behavior. For application code, require hash tags such as `cart:{userId}:items` and `cart:{userId}:totals` when related keys must be used together.

Reference: [Azure Managed Redis architecture](https://learn.microsoft.com/en-us/azure/redis/architecture)
