---
title: Use Hash Tags for Multi-Key Operations in Clustered Redis
impact: MEDIUM-HIGH
impactDescription: avoids CROSSSLOT errors in clustered caches
tags: cluster, hash-tags, keys, multi-key
---

## Use Hash Tags for Multi-Key Operations in Clustered Redis

In clustered Redis (including Azure Managed Redis with OSS cluster policy), multi-key commands require all keys to map to the same hash slot. Use hash tags (`{...}`) in keys so related keys co-locate, enabling commands like MGET, MSET, and transactions without CROSSSLOT errors.

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

Reference: [Redis Cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
