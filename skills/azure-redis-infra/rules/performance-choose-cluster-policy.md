---
title: Choose Cluster Policy Based on Client and Module Needs
impact: MEDIUM
impactDescription: prevents client incompatibility and throughput bottlenecks
tags: performance, cluster-policy, oss, enterprise, modules
---

## Choose Cluster Policy Based on Client and Module Needs

Azure Managed Redis supports OSSCluster, EnterpriseCluster, and NoCluster policies. Choose the policy explicitly based on client capabilities, module requirements, cache size, and multi-key command behavior; do not rely on provider defaults. AMR manages partitioning internally, so avoid describing the service in terms of customer-managed shard counts. In customer-facing guidance, say tier, SKU, capacity or usable memory, and cluster policy instead of "number of shards."

Azure Managed Redis supports one database per instance and blocks `SELECT`, regardless of cluster policy. Do not rely on numbered database indexes for logical separation; use application key prefixes, and separate caches when hard isolation is required. See [AMR configuration](https://learn.microsoft.com/en-us/azure/redis/configure#other-configuration-information).

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
Logical databases: one per instance; do not use SELECT or numbered DB indexes
Scale language: tier, SKU, capacity, usable memory, and cluster policy
Multi-key/Lua: keys use hash tags or avoid cross-slot operations
```

Prefer `NoCluster` when the workload fits its supported size and needs single-endpoint semantics with the least CROSSSLOT risk, especially when the application is not Redis Cluster-aware. Use `OSSCluster` only when clients handle MOVED/ASK redirects and operational runbooks account for cluster topology. Use `EnterpriseCluster` when module support or client compatibility requires it, while still checking multi-key commands and Lua scripts for cross-slot behavior. For application code, require hash tags such as `cart:{userId}:items` and `cart:{userId}:totals` when related keys must be used together.

Module support constrains the policy choice. RediSearch requires the Enterprise cluster policy and cannot be used with `OSSCluster`, so search or vector workloads require `EnterpriseCluster`. Active geo-replication supports only RediSearch and RedisJSON. Module availability varies by tier; confirm the selected module and cluster policy against the current Azure Managed Redis documentation before provisioning.

Reference: [Azure Managed Redis architecture](https://learn.microsoft.com/en-us/azure/redis/architecture), [Active geo-replication for Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/how-to-active-geo-replication)
