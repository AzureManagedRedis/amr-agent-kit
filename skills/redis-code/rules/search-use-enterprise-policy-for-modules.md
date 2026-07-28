---
title: Match Search and JSON Modules to the Cluster Policy
impact: CRITICAL
impactDescription: avoids unsupported module/cluster combinations
tags: azure-managed-redis, redisearch, redisjson, cluster-policy
---

## Match Search and JSON Modules to the Cluster Policy

On Azure Managed Redis, the Search module (RediSearch) is incompatible with `OSSCluster`; choose `EnterpriseCluster` or a supported `NoCluster` size for search and vector workloads. RedisJSON does not share that prohibition and can be used with `OSSCluster`, subject to the selected SKU and other feature constraints. Active geo-replication supports only the Search and JSON modules, and Search on flash-optimized SKUs can be availability restricted, so validate the complete SKU, policy, module, region, preview or subscription-allowlist status, flash restrictions, and geo combination before provisioning.

**Incorrect (OSS cluster with Search):**

```text
Cluster policy: OSS
Modules: RediSearch
Result: Search is not supported with OSSCluster
```

**Correct (policy matches the required module):**

```text
Cluster policy: EnterpriseCluster
Modules: RediSearch, RedisJSON
Result: vector search and JSON features available

Cluster policy: OSSCluster
Modules: RedisJSON
Result: JSON is allowed; validate the selected SKU and any geo requirements
```

Reference: [Azure Managed Redis architecture](https://learn.microsoft.com/en-us/azure/redis/architecture)
