---
title: Plan Active Geo-Replication for Multi-Region DR
impact: HIGH
impactDescription: reduces regional outage risk
tags: geo-replication, dr, active-active, consistency
---

## Plan Active Geo-Replication for Multi-Region DR

Active geo-replication groups up to five Azure Managed Redis instances across regions in an active-active configuration. Plan for eventual consistency, application-level conflict behavior, and client endpoint selection before provisioning. Ensure all linked instances use matching configuration, and verify tier/module support because active geo-replication is not available for every SKU or module combination.

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

Do not combine active geo-replication with persistence. Treat active geo-replication as a DR and multi-region availability pattern, not a synchronous zero-loss replication guarantee. Monitor replication health and test client failover paths before production.

Reference: [Active geo-replication for Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/how-to-active-geo-replication)
