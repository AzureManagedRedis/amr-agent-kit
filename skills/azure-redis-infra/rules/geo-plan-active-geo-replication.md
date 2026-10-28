---
title: Plan Active Geo-Replication for Multi-Region DR
impact: HIGH
impactDescription: reduces regional outage risk
tags: geo-replication, dr, active-active, consistency
---

## Plan Active Geo-Replication for Multi-Region DR

Active geo-replication groups up to five Azure Managed Redis instances across regions. Use it for multi-region, active-active designs only after reviewing the current [scope of availability](https://learn.microsoft.com/en-us/azure/redis/how-to-active-geo-replication#scope-of-availability) and [prerequisites](https://learn.microsoft.com/en-us/azure/redis/how-to-active-geo-replication#active-geo-replication-prerequisites). Plan around the documented eventual-consistency model, compatible and matching instance configuration, application conflict behavior, and client endpoint selection. Verify tier and module support because active geo-replication is not available for every SKU or module combination. Do not combine active geo-replication with data persistence.

**Incorrect (mix configurations or link an existing cache without planning for data loss):**

```text
Availability and prerequisites: assumed, not checked
Regional configuration: intentionally different
Persistence: Enabled
Consistency model: assumed to be synchronous
Existing cache: linked without reviewing documented impact
```

**Correct (plan the group up front and design for eventual consistency):**

```text
Availability and prerequisites: validated against current AMR documentation
All regions: compatible and matching configuration
Persistence: Disabled
Consistency: application behavior designed for the documented model
Clients: region-aware routing and tested failover
```

Treat active geo-replication as a DR and multi-region availability pattern, not an assumed synchronous zero-loss guarantee. When [adding an existing instance](https://learn.microsoft.com/en-us/azure/redis/how-to-active-geo-replication#add-an-existing-instance-to-an-active-geo-replication-group), the documented REST force-link operation discards all data in the joining instance and makes it temporarily unavailable for several minutes. Plan for that data loss and outage; verify the current procedure before linking. Monitor the currently documented [AMR metrics](https://learn.microsoft.com/en-us/azure/redis/monitor-cache-reference), and measure application-level convergence separately when the RPO requires it. Define retry deadlines, make write paths idempotent where regional replay is possible, and test client endpoint failover paths before production.

Reference: [Active geo-replication for Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/how-to-active-geo-replication)
