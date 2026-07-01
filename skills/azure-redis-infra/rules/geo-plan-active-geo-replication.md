---
title: Plan Active Geo-Replication for Multi-Region DR
impact: HIGH
impactDescription: reduces regional outage risk
tags: geo-replication, dr, active-active, consistency
---

## Plan Active Geo-Replication for Multi-Region DR

Active geo-replication groups up to five Azure Managed Redis instances across regions in an active-active configuration. Plan for eventual consistency and enable geo-replication during provisioning because caches without it cannot join a group later. Ensure all instances use the same configuration.

**Incorrect (assume you can add geo-replication later or mix configs):**

```text
ActiveGeoReplication: Disabled at creation
Region B: different SKU and modules
Consistency expectations: strong, synchronous
```

**Correct (enable at creation and design for eventual consistency):**

```text
ActiveGeoReplication: Enabled at creation
All regions: same SKU, modules, policies
Consistency expectations: eventual
```

Reference: [Active geo-replication for Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/how-to-active-geo-replication)
