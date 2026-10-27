---
title: Match Search and JSON Modules to the Cluster Policy
impact: CRITICAL
impactDescription: avoids unsupported module/cluster combinations
tags: azure-managed-redis, redisearch, redisjson, cluster-policy
---

## Match Search and JSON Modules to the Cluster Policy

On Azure Managed Redis, the Search module (RediSearch) requires the Enterprise cluster policy and `NoEviction`; it cannot be used with `OSSCluster` or `NoCluster`. Select `EnterpriseCluster` for search and vector workloads. The public modules documentation does not explicitly establish RedisJSON compatibility with `OSSCluster`; do not infer either support or incompatibility from Search's restriction. Confirm the selected combination against a public service compatibility reference before recommending it. Active geo-replication supports only the Search and JSON modules. Search is not offered on Flash Optimized tiers in the current public module matrix, so validate the complete SKU, policy, module, region, preview status, flash restrictions, and geo combination before provisioning.

**Incorrect (OSS cluster with Search):**

```text
Cluster policy: OSS
Modules: RediSearch
Result: Search is not supported with OSSCluster
```

**Correct (policy matches the required module):**

```text
Cluster policy: EnterpriseCluster
Eviction policy: NoEviction
Modules: RediSearch, RedisJSON
Validation: confirm the selected tier, region, and geo configuration
Result: documented cluster and eviction policies for Search with JSON
```

Reference: [Azure Managed Redis architecture](https://learn.microsoft.com/en-us/azure/redis/architecture)

Reference: [Azure Managed Redis module compatibility](https://learn.microsoft.com/en-us/azure/redis/redis-modules)
