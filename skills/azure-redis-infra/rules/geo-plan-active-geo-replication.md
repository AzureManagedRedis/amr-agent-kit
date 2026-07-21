---
title: Plan Active Geo-Replication for Multi-Region DR
impact: HIGH
impactDescription: reduces regional outage risk
tags: geo-replication, dr, active-active, consistency
---

## Plan Active Geo-Replication for Multi-Region DR

The shipped effective limit for an active geo-replication group is five Azure Managed Redis instances across regions. Treat that as a config-driven limit rather than a hard engine constant, and account for the migration-only exception in which a mixed Gen1/Gen2 group can temporarily contain a sixth member. Plan for eventual consistency, application-level conflict behavior, and client endpoint selection before provisioning. Keep required configuration aligned across members and verify tier/module support because active geo-replication is not available for every SKU or module combination.

**Incorrect (assume you can add geo-replication later or mix configs):**

```text
ActiveGeoReplication: Disabled at creation
Region B: different SKU and modules
Persistence: Enabled
Consistency expectations: strong, synchronous
```

**Correct (enable at creation and design for eventual consistency):**

```text
ActiveGeoReplication: Enabled at creation
All regions: same SKU, modules, policies
Persistence: Disabled
Consistency expectations: eventual
Clients: region-aware routing and tested failover
```

Do not combine active geo-replication with persistence. Treat active geo-replication as a DR and multi-region availability pattern, not a synchronous zero-loss replication guarantee. Monitor replication health and lag, define retry deadlines, make write paths idempotent where regional replay is possible, and test client endpoint failover paths before production.

Before changing membership, read the effective service limit for the target environment. Do not treat the temporary sixth member allowed during a supported mixed-generation migration as general six-region capacity.

Reference: [Active geo-replication for Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/how-to-active-geo-replication)
