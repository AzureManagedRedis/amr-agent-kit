---
title: Select the Right Tier and SKU Before Provisioning
impact: CRITICAL
impactDescription: avoids under-provisioning and rework
tags: provisioning, sizing, tier, sku, capacity, region
---

## Select the Right Tier and SKU Before Provisioning

Azure Managed Redis tiers (Memory Optimized, Balanced, Compute Optimized, Flash Optimized) have different memory-to-vCPU ratios and performance profiles. Choose the tier, size, and region that match latency targets and dataset size, and enable features like active geo-replication at creation time because they cannot be added later. Under-sizing or picking the wrong tier forces disruptive reprovisioning.

**Incorrect (pick the smallest tier and plan to change later):**

```text
# Smallest tier chosen for a latency-sensitive workload
Tier: Balanced B10
Performance: Low
ActiveGeoReplication: Disabled  # plan to enable after go-live (not supported)
Region: East US
```

**Correct (size for workload and enable required features up front):**

```text
# Match tier to workload and enable geo-replication at creation time
Tier: Compute Optimized X20
Performance: High throughput
ActiveGeoReplication: Enabled
Region: same as application region
```

Reference: [Create Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/quickstart-create-managed-redis), [Azure Managed Redis overview](https://learn.microsoft.com/en-us/azure/redis/overview)
