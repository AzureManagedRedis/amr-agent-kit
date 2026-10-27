---
title: Plan Active Geo-Replication for Multi-Region DR
impact: HIGH
impactDescription: reduces regional outage risk
tags: geo-replication, dr, active-active, consistency
---

## Plan Active Geo-Replication for Multi-Region DR

Use active geo-replication for multi-region, active-active designs only after reviewing the current [scope of availability](https://learn.microsoft.com/en-us/azure/redis/how-to-active-geo-replication#scope-of-availability) and [prerequisites](https://learn.microsoft.com/en-us/azure/redis/how-to-active-geo-replication#active-geo-replication-prerequisites). Plan around the documented eventual-consistency model, compatible and matching instance configuration, application conflict behavior, and client endpoint selection. Verify tier and module support because active geo-replication is not available for every SKU or module combination.

**Incorrect (mix configurations or link an existing cache without planning for data loss):**

```text
Availability and prerequisites: assumed, not checked
Regional configuration: intentionally different
Consistency model: assumed to be synchronous
Existing cache: linked without reviewing documented impact
```

**Correct (plan the group up front and design for eventual consistency):**

```text
Availability and prerequisites: validated against current AMR documentation
All regions: compatible and matching configuration
Consistency: application behavior designed for the documented model
Clients: region-aware routing and tested failover
```

Treat active geo-replication as a DR and multi-region availability pattern, not an assumed synchronous zero-loss guarantee. Follow the current documented procedure when [adding an existing instance](https://learn.microsoft.com/en-us/azure/redis/how-to-active-geo-replication#add-an-existing-instance-to-an-active-geo-replication-group), including its stated data and availability effects. Monitor the currently documented [AMR metrics](https://learn.microsoft.com/en-us/azure/redis/monitor-cache-reference), and measure application-level convergence separately when the RPO requires it. Define retry deadlines, make write paths idempotent where regional replay is possible, and test client endpoint failover paths before production.

Reference: [Active geo-replication for Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/how-to-active-geo-replication)
