---
title: Use Hash Tags for Multi-Key Operations in Clustered Redis
impact: MEDIUM-HIGH
impactDescription: avoids CROSSSLOT errors in clustered caches
tags: cluster, hash-tags, keys, multi-key
---

## Use Hash Tags for Multi-Key Operations in Clustered Redis

Whether a multi-key command needs all keys in the same hash slot depends on the Azure Managed Redis cluster policy and active geo-replication. Under `OSSCluster` (OSS Cluster API), every multi-key command — MGET, MSET, DEL, UNLINK, EXISTS, TOUCH, transactions, and Lua scripts — requires all keys to map to the same slot, or Redis returns `CROSSSLOT`. Under `EnterpriseCluster` without active geo-replication, MGET, MSET, DEL, UNLINK, EXISTS, and TOUCH can span slots. With active geo-replication, DEL, MSET, and UNLINK require same-slot keys; only MGET, EXISTS, and TOUCH retain the cross-slot exception. Atomic operations (MULTI/EXEC/WATCH and Lua scripts that declare keys in `KEYS`) and commands that write to a computed destination key (for example `*STORE`, `COPY`, `RENAME`, `SMOVE`, `BITOP`, `PFMERGE`) still require every key in the same slot. Under `NoCluster` the keyspace is unsharded, so no slot constraint applies. Hash tags (`{...}`) are the portable co-location mechanism: use them for keys that must be operated on together rather than assuming they are universally mandatory for every Enterprise command. Choose `NoCluster` only when the target AMR size and workload fit its restrictions; use `OSSCluster` only when the client handles MOVED/ASK redirects and every multi-key path is slot-safe. `EnterpriseCluster` also supports non-cluster-aware clients.

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

For Azure Managed Redis, coordinate key design with the selected `clusteringPolicy`, active geo-replication, and the client's cluster awareness. `NoCluster` avoids hash-slot constraints when supported by the target size. `OSSCluster` requires Redis Cluster-aware clients and same-slot placement for every related multi-key operation, transaction, and Lua script. Under `EnterpriseCluster`, distinguish the documented cross-slot exceptions above from transactions, Lua scripts that declare keys in `KEYS`, and destination-key commands, which still need co-located keys. When adding active geo-replication, audit DEL/MSET/UNLINK paths for same-slot placement rather than assuming existing Enterprise cross-slot writes remain valid.

When reviewing logical-database, cluster-policy, multi-key, transaction, or Lua designs, surface the AMR client assumptions alongside key guidance: use the service-returned host and port (`10000` is the default database port), use TLS or `rediss://` with certificate validation, reuse a singleton/pool/multiplexer, and only choose `OSSCluster` when that reusable client is Redis Cluster-aware.

Reference: [Redis Cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)

Reference: [AMR multi-key and active geo-replication compatibility](https://learn.microsoft.com/en-us/azure/redis/choose-clustering-policy#multikey-commands-and-crossslot-behavior)
