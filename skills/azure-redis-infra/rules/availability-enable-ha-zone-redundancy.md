---
title: Enable High Availability and Zone Redundancy
impact: HIGH
impactDescription: improves resilience to node and zone failures
tags: availability, zone-redundancy, high-availability
---

## Enable High Availability and Zone Redundancy

Azure Managed Redis recommends high availability for production, which deploys multiple nodes and replicates data across them. For Gen2 AMR, enable high availability but omit the `zones` property at creation; the service handles zone placement in supported regions, and supplying explicit zones is rejected. Explicit zone lists apply to Gen1/ACRE zonal deployments, which require at least three zones in a supported region.

**Incorrect (single node, no zone redundancy):**

```text
High Availability: Disabled
Zone Redundancy: Not configured
```

**Correct (use the generation-specific shape):**

```text
Gen2 AMR:
High Availability: Enabled
zones: omitted
Region: supports availability zones

Gen1/ACRE zonal deployment:
High Availability: Enabled
zones: at least three valid zones
```

Reference: [Reliability in Azure Managed Redis](https://learn.microsoft.com/en-us/azure/reliability/reliability-managed-redis)
