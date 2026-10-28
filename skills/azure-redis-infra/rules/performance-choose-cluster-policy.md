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
Cluster policy: NoCluster only for caches 25 GB or smaller
Cluster policy: OSSCluster only for Redis Cluster-aware clients
Cluster policy: EnterpriseCluster when required by modules or client compatibility
Logical databases: one per instance; do not use SELECT or numbered DB indexes
Scale language: tier, SKU, capacity, usable memory, and cluster policy
Multi-key/Lua: honor the selected policy's cross-slot restrictions
```

Prefer `NoCluster` only for caches 25 GB or smaller when the workload needs nonsharded semantics, especially when the application can't support OSS or Enterprise topology. Scaling above 25 GB requires changing the cluster policy first, and the policy can't be changed after geo-replication is enabled. Use `OSSCluster` only when clients handle MOVED/ASK redirects and operational runbooks account for cluster topology. Use `EnterpriseCluster` when RediSearch or client compatibility requires it, while still checking multi-key commands and Lua scripts for cross-slot behavior.

`NoCluster` has no slot-based multi-key restriction. `OSSCluster` requires all keys in a multi-key command to share a hash slot. `EnterpriseCluster` permits `DEL`, `MSET`, `MGET`, `EXISTS`, `UNLINK`, and `TOUCH` across slots, but this is not a blanket exemption for other commands, transactions, or Lua scripts. Active-Active databases further restrict multi-key writes (`DEL`, `MSET`, `UNLINK`) to one slot; only `MGET`, `EXISTS`, and `TOUCH` can span slots there. Use hash tags such as `cart:{userId}:items` and `cart:{userId}:totals` when the selected operation requires co-location, not for every multi-key command under every policy.

Module support constrains the policy choice. RediSearch requires the Enterprise cluster policy and cannot be used with `OSSCluster`, so search or vector workloads require `EnterpriseCluster`. Active geo-replication supports only RediSearch and RedisJSON. Module availability varies by tier; confirm the selected module and cluster policy against the current Azure Managed Redis documentation before provisioning.

Reference: [Azure Managed Redis architecture](https://learn.microsoft.com/en-us/azure/redis/architecture), [Active geo-replication for Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/how-to-active-geo-replication)
