---
title: Select the Right Tier and SKU Before Provisioning
impact: CRITICAL
impactDescription: avoids under-provisioning and rework
tags: provisioning, sizing, tier, sku, capacity, region
---

## Select the Right Tier and SKU Before Provisioning

Azure Managed Redis tiers (Memory Optimized, Balanced, Compute Optimized, Flash Optimized) have different memory-to-vCPU ratios, connection limits, and performance profiles. Choose the tier, size, and region from workload evidence: peak and P95 used memory, server load or CPU pressure, connected clients, cache read/write bandwidth, latency SLOs, required modules, and availability/DR needs. Avoid sizing from a source SKU label alone; compare usable memory and compute pressure to the target tier.

**Incorrect (pick the smallest tier and plan to change later):**

```text
Workload evidence: not collected
Tier: Balanced B10 because it is small
Server load / client count: unknown
Modules: decide after go-live
Active geo-replication: plan to add later
```

**Correct (size for workload and enable required features up front):**

```text
Metric window: 7+ days including peak/P95
Used memory: target usable memory >= peak used memory
Server load / clients / bandwidth: choose M, B, X, or Flash based on bottleneck
Modules and cluster policy: selected before create
Active geo-replication: enabled during provisioning if required
Region: same Azure region as latency-sensitive clients where possible
```

Use Memory Optimized (M-series) when dataset size is the main constraint and compute pressure is moderate. Use Balanced (B-series) for general-purpose workloads with mixed memory and compute needs. Use Compute Optimized (X-series) when server load, command complexity, bandwidth, or connected-client pressure is high relative to memory. Use Flash Optimized for very large datasets where tiered storage is acceptable and feature support matches the workload. Treat preview sizes and regional availability as explicit validation items.

Reference: [Create Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/quickstart-create-managed-redis), [Azure Managed Redis overview](https://learn.microsoft.com/en-us/azure/redis/overview)
