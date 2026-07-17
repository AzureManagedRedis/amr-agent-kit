---
title: Use Hash Tags for Multi-Key Operations in Clustered Redis
impact: MEDIUM-HIGH
impactDescription: avoids CROSSSLOT errors in clustered caches
tags: cluster, hash-tags, keys, multi-key
---

## Use Hash Tags for Multi-Key Operations in Clustered Redis

In clustered Redis (including Azure Managed Redis with OSSCluster policy), multi-key commands require all keys to map to the same hash slot. Use hash tags (`{...}`) in keys so related keys co-locate, enabling commands like MGET, MSET, transactions, and Lua scripts without `CROSSSLOT` errors. Prefer `NoCluster` when the target AMR size supports it and the application needs single-endpoint semantics or is not Redis Cluster-aware; use `OSSCluster` only when the client handles MOVED/ASK redirects and every multi-key path is slot-safe.

**Incorrect (keys map to different slots):**

```text
prod:tenant:contoso:cart:v1:user:1001:items
prod:tenant:contoso:cart:v1:user:1001:totals
```

This can fail under OSSCluster with `CROSSSLOT Keys in request don't hash to the same slot`.

**Correct (use hash tag to co-locate):**

```text
prod:tenant:{contoso:user:1001}:cart:v1:items
prod:tenant:{contoso:user:1001}:cart:v1:totals
```

The value inside `{...}` should be the smallest stable routing key for the keys that must be read or written together. Do not hash tag the whole tenant unless co-locating all tenant keys is intentional; that can create hot slots. For Lua scripts, pass every Redis key through `KEYS[]` and values through `ARGV[]`. Do not construct hidden key names inside the script, because Redis Cluster clients can only route and validate declared keys, and every declared key must share the same hash tag.

For Azure Managed Redis, coordinate key design with the selected `clusteringPolicy`. `NoCluster` avoids cluster hash-slot constraints when supported by the target size and is the safer default for non-cluster-aware applications. `OSSCluster` requires Redis Cluster-aware clients and hash tags for any related multi-key operation; otherwise multi-key commands, transactions, and Lua scripts can fail with `CROSSSLOT`. `EnterpriseCluster` can improve compatibility for some clients and modules, but application code should still avoid accidental multi-key or Lua operations across unrelated hash slots.

When reviewing DB0/SELECT, cluster-policy, multi-key, transaction, or Lua designs, surface the AMR client assumptions alongside key guidance: connect to the normal `<cache-name>.<region>.redis.azure.net` host on port `10000`, use TLS or `rediss://` with certificate validation, reuse a singleton/pool/multiplexer, and only choose `OSSCluster` when that reusable client is Redis Cluster-aware.

Reference: [Redis Cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
