---
title: Choose Cluster Policy Based on Client and Module Needs
impact: MEDIUM
impactDescription: prevents client incompatibility and throughput bottlenecks
tags: performance, cluster-policy, oss, enterprise, modules
---

## Choose Cluster Policy Based on Client and Module Needs

Azure Managed Redis supports OSS, Enterprise, and Non-clustered policies. OSS clustering provides the best throughput but requires Redis Cluster-capable clients and uses additional shard ports. Enterprise clustering uses a proxy endpoint and is required for RediSearch and RedisJSON modules. Choose the policy based on client capabilities and module requirements.

**Incorrect (select OSS when clients and modules require Enterprise):**

```text
Cluster policy: OSS
Client library: not Redis Cluster-aware
Modules: RediSearch enabled
```

**Correct (align policy with client/module requirements):**

```text
Cluster policy: Enterprise
Client library: standard Redis client
Modules: RediSearch/RedisJSON enabled
```

Reference: [Azure Managed Redis architecture](https://learn.microsoft.com/en-us/azure/redis/architecture)
