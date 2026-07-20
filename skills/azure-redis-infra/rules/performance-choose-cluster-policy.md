---
title: Choose Cluster Policy Based on Client and Module Needs
impact: MEDIUM
impactDescription: prevents client incompatibility and throughput bottlenecks
tags: performance, cluster-policy, oss, enterprise, modules
---

## Choose Cluster Policy Based on Client and Module Needs

Azure Managed Redis supports OSSCluster, EnterpriseCluster, and NoCluster policies. Choose the policy explicitly based on client capabilities, module requirements, cache size, and multi-key command behavior; do not rely on provider defaults. AMR manages partitioning internally, so avoid describing the service in terms of customer-managed shard counts. In customer-facing guidance, say tier, SKU, capacity or usable memory, and cluster policy instead of "number of shards."

Cluster policy also constrains logical-database semantics. Under clustered policies (OSSCluster, EnterpriseCluster) and under active geo-replication, only database 0 is available and `SELECT` to a non-zero index is not supported, so plan for a single logical database. Under `NoCluster`, do not assert either DB0-only or multi-database behavior without evidence; a single managed `default` database resource does not prove the logical database count, so confirm it from the effective server configuration or a live `SELECT` capability check before relying on more than database 0. In all cases, prefer application key prefixes for portable logical separation and separate caches for hard isolation rather than numbered DB indexes.

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
Logical databases: DB0-only under clustered/active-geo; verify under NoCluster before using more than DB0
Scale language: tier, SKU, capacity, usable memory, and cluster policy
Multi-key/Lua: keys use hash tags or avoid cross-slot operations
```

Prefer `NoCluster` when the workload fits its supported size and needs single-endpoint semantics with the least CROSSSLOT risk, especially when the application is not Redis Cluster-aware. Use `OSSCluster` only when clients handle MOVED/ASK redirects and operational runbooks account for cluster topology. Use `EnterpriseCluster` when module support or client compatibility requires it, while still checking multi-key commands and Lua scripts for cross-slot behavior. For application code, require hash tags such as `cart:{userId}:items` and `cart:{userId}:totals` when related keys must be used together.

Reference: [Azure Managed Redis architecture](https://learn.microsoft.com/en-us/azure/redis/architecture)
