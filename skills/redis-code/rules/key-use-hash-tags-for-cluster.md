---
title: Use Hash Tags for Multi-Key Operations in Clustered Redis
impact: MEDIUM-HIGH
impactDescription: avoids CROSSSLOT errors in clustered caches
tags: cluster, hash-tags, keys, multi-key
---

## Use Hash Tags for Multi-Key Operations in Clustered Redis

Whether a multi-key command needs all keys in the same hash slot depends on the Azure Managed Redis cluster policy, not on a single universal rule. Under `OSSCluster` (OSS Cluster API), every multi-key command — MGET, MSET, DEL, UNLINK, EXISTS, TOUCH, transactions, and Lua scripts — requires all keys to map to the same slot, or Redis returns `CROSSSLOT`. Under `EnterpriseCluster`, the cluster can be configured to scatter-gather selected non-atomic multi-key commands (MGET, MSET, DEL, UNLINK, EXISTS, TOUCH) across slots, so those specific commands may work without co-location; but atomic operations (MULTI/EXEC/WATCH and Lua scripts that declare keys in `KEYS`) and commands that write to a computed destination key (for example `*STORE`, `COPY`, `RENAME`, `SMOVE`, `BITOP`, `PFMERGE`) still require every key in the same slot. Under `NoCluster` the keyspace is unsharded, so no slot constraint applies. Hash tags (`{...}`) are the portable co-location mechanism: they keep related keys in one slot across every policy, so use them for keys that must be operated on together rather than assuming they are universally mandatory for every non-atomic Enterprise command. Prefer `NoCluster` when the target AMR size supports it and the application needs single-endpoint semantics or is not Redis Cluster-aware; use `OSSCluster` only when the client handles MOVED/ASK redirects and every multi-key path is slot-safe.

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

For Azure Managed Redis, coordinate key design with the selected `clusteringPolicy` and the client's cluster awareness. `NoCluster` avoids cluster hash-slot constraints entirely when supported by the target size and is the safer default for non-cluster-aware applications. `OSSCluster` requires Redis Cluster-aware clients and same-slot placement (hash tags) for every related multi-key operation, transaction, and Lua script; otherwise those commands can fail with `CROSSSLOT`. `EnterpriseCluster` can relax co-location for selected non-atomic multi-key commands when configured to route them across slots, and can improve compatibility for some clients and modules, but transactions, Lua scripts that declare keys in `KEYS`, and destination-key commands still need co-located keys, and application code should still avoid accidental cross-slot atomic operations. Do not treat hash tags as universally required for every Enterprise multi-key command, and do not assume a non-cluster-aware client will work under `OSSCluster`.

When reviewing logical-database, cluster-policy, multi-key, transaction, or Lua designs, surface the AMR client assumptions alongside key guidance: connect to the normal `<cache-name>.<region>.redis.azure.net` host on port `10000`, use TLS or `rediss://` with certificate validation, reuse a singleton/pool/multiplexer, and only choose `OSSCluster` when that reusable client is Redis Cluster-aware.

Reference: [Redis Cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
