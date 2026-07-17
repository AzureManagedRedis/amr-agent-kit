---
title: Use Enterprise Cluster Policy for RediSearch and RedisJSON
impact: CRITICAL
impactDescription: avoids unsupported module/cluster combinations
tags: azure-managed-redis, redisearch, redisjson, cluster-policy
---

## Use Enterprise Cluster Policy for RediSearch and RedisJSON

On Azure Managed Redis, RediSearch and RedisJSON require the Enterprise cluster policy. OSS cluster policy doesn't support RediSearch. Select the Enterprise policy at provisioning time when you need vector search or JSON documents.

**Incorrect (OSS cluster with RediSearch/RedisJSON):**

```text
Cluster policy: OSS
Modules: RediSearch, RedisJSON
Result: module not supported with OSS policy
```

**Correct (Enterprise cluster with modules):**

```text
Cluster policy: Enterprise
Modules: RediSearch, RedisJSON
Result: vector search and JSON features available
```

Reference: [Azure Managed Redis architecture](https://learn.microsoft.com/en-us/azure/redis/architecture)
