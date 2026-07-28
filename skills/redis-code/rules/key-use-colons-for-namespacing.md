---
title: Use Colons for Key Namespacing
impact: CRITICAL
impactDescription: enables organized keyspace and efficient scanning
tags: keys, naming, namespacing, conventions, db0, tenancy
---

## Use Colons for Key Namespacing

Use colon-separated hierarchical key names to organize your keyspace. This convention is widely adopted and enables efficient key scanning and management. Prefer explicit key prefixes over Redis logical databases (`SELECT`/`db=N`) for tenant, environment, workload, and schema-version separation, because logical-database availability on Azure Managed Redis is topology-dependent: clustered policies (`OSSCluster`, `EnterpriseCluster`) and active geo-replication (CRDB) are engine-constrained to database 0 only, while a non-clustered (`NoCluster`) cache can permit more than one logical database. Do not assume AMR/ACRE is universally single-database, and never infer the logical-database count from the single managed database resource in the control plane; verify the effective configuration or probe with a live `SELECT` before relying on any database other than 0. Key prefixes stay correct across every topology, so they are the portable choice.

**Incorrect (inconsistent or flat naming):**

```python
import redis
r = redis.Redis(
    host='mycache.eastus.redis.azure.net',
    port=10000,
    ssl=True,
    decode_responses=True
)
# Flat, inconsistent naming - hard to manage
r.set("user1name", "John")
r.set("user_1_email", "john@example.com")
r.set("1-user-age", "30")
r.set("sessionabc123", "data")

# Azure Cache for Redis-style logical DB tenancy does not port to AMR
r.execute_command("SELECT", tenant_db_index)
r.set("session:abc123", session_payload, ex=3600)

# No way to efficiently find all user keys
# KEYS * would return everything
```

**Correct (hierarchical colon-separated naming):**

```python
import redis
r = redis.Redis(
    host='mycache.eastus.redis.azure.net',
    port=10000,
    ssl=True,
    decode_responses=True
)
# Consistent hierarchical naming: object-type:id:field
r.set("user:1000:name", "John")
r.set("user:1000:email", "john@example.com")
r.hset("user:1000:profile", mapping={"age": "30", "city": "NYC"})

# Session keys with clear namespace
r.set("session:abc123:data", "session_data")
r.set("session:abc123:user_id", "1000")

# Cache keys with clear purpose and schema/data version
r.set("cache:api:v1:users:list", cached_response, ex=900)
r.set("cache:db:v2:query:hash123", cached_result, ex=900)

# Rate limiting keys
r.set("ratelimit:api:user:1000", "5")

# Logical database or tenant separation through prefixes
r.set("prod:tenant:contoso:session:v1:abc123", session_payload, ex=3600)
r.set("prod:tenant:fabrikam:session:v1:def456", other_session_payload, ex=3600)

# Canonical AMR prefix template:
# <env>:tenant:<tenantId>:<workload>:v<schemaVersion>:<entity>:<id>
r.set("prod:tenant:contoso:cart:v1:user:1000:items", cart_items, ex=900)
r.set("prod:tenant:contoso:cart:v1:user:1000:totals", cart_totals, ex=900)

# Scan for all user keys efficiently
cursor = 0
while True:
    cursor, keys = r.scan(cursor, match="user:*", count=100)
    for key in keys:
        print(key)
    if cursor == 0:
        break

# Scan for all sessions
for key in r.scan_iter(match="session:*"):
    print(key)

# Scan only the tenant/workload/version prefix you own
for key in r.scan_iter(match="prod:tenant:contoso:cart:v1:*", count=1000):
    print(key)
```

The colon convention is not enforced by Redis but is a widely adopted standard. It makes keys self-documenting and enables pattern-based operations with SCAN. For Azure Managed Redis, prefer keeping application data in database 0 for portability, and use a prefix template such as `<env>:tenant:<tenantId>:<workload>:v<schemaVersion>:<entity>:<id>` for logical separation. Do not rely on additional logical databases unless you have confirmed that the specific cache topology supports them; clustered and geo-replicated caches provide only database 0. For caches, include a version segment such as `v1` or a data-contract version so deploys and schema changes can invalidate safely without broad deletes.

When refactoring an application that used Azure Cache for Redis logical databases for tenancy, prefer replacing `SELECT`, `db=N`, tenant-to-database maps, and `FLUSHDB` cleanup with explicit key prefixes, because DB-index tenancy does not survive a move to a clustered or geo-replicated AMR topology even where a non-clustered cache would technically allow multiple databases. Add a central key builder that requires environment, tenant, workload, schema version, entity, and identifier; change maintenance jobs to `SCAN MATCH <prefix>:* COUNT ...` with batched `DEL` or `UNLINK`; enforce tenant boundaries with application authorization, Redis ACL/data access key patterns, and metadata filters for search/RAG workloads. Use separate Azure Managed Redis caches when tenants require hard isolation, independent lifecycle, or separate compliance boundaries.

Reference: [Redis Keys](https://redis.io/docs/latest/develop/use/keyspace/)
