---
title: Enable High Availability and Zone Redundancy
impact: HIGH
impactDescription: improves resilience to node and zone failures
tags: availability, zone-redundancy, high-availability
---

## Enable High Availability and Zone Redundancy

Azure Managed Redis recommends high availability for production, which deploys multiple nodes and replicates data across them. In supported regions, high availability automatically distributes AMR nodes across availability zones; no separate zone selection is needed. In regions without availability zones, high availability still creates multiple nodes, but they are not placed in separate zones.

**Incorrect (single node, no zone redundancy):**

```text
High Availability: Disabled
Zone Redundancy: Not configured
```

**Correct (enable high availability):**

```text
High Availability: Enabled
Region: supports availability zones for automatic zone redundancy
```

Reference: [Reliability in Azure Managed Redis](https://learn.microsoft.com/en-us/azure/reliability/reliability-managed-redis)
