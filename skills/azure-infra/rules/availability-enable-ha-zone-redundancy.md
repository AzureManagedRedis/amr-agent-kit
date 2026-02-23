---
title: Enable High Availability and Zone Redundancy
impact: HIGH
impactDescription: improves resilience to node and zone failures
tags: availability, zone-redundancy, high-availability
---

## Enable High Availability and Zone Redundancy

Azure Managed Redis recommends high availability for production, which deploys multiple nodes and replicates data across them. In regions with availability zones, enable zone redundancy to place nodes in separate zones for better resilience.

**Incorrect (single node, no zone redundancy):**

```text
High Availability: Disabled
Zone Redundancy: Not configured
```

**Correct (HA with zone redundancy in supported regions):**

```text
High Availability: Enabled
Zone Redundancy: Enabled
Region: supports availability zones
```

Reference: [Reliability in Azure Managed Redis](https://learn.microsoft.com/en-us/azure/reliability/reliability-managed-redis)
