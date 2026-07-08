---
title: Use Hash Tags for Multi-Key Operations in Clustered Redis
impact: MEDIUM-HIGH
impactDescription: avoids CROSSSLOT errors in clustered caches
tags: cluster, hash-tags, keys, multi-key
---

## Use Hash Tags for Multi-Key Operations in Clustered Redis

In clustered Redis (including Azure Managed Redis with OSSCluster policy), multi-key commands require all keys to map to the same hash slot. Use hash tags (`{...}`) in keys so related keys co-locate, enabling commands like MGET, MSET, transactions, and Lua scripts without CROSSSLOT errors.

**Incorrect (keys map to different slots):**

```text
user:1001:profile
user:1001:settings
```

**Correct (use hash tag to co-locate):**

```text
user:{1001}:profile
user:{1001}:settings
```

For Azure Managed Redis, coordinate key design with the selected `clusteringPolicy`. `NoCluster` avoids cluster hash-slot constraints when supported by the target size. `OSSCluster` requires Redis Cluster-aware clients and hash tags for any related multi-key operation. `EnterpriseCluster` can improve compatibility for some clients and modules, but application code should still avoid accidental multi-key or Lua operations across unrelated hash slots.

Reference: [Redis Cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
