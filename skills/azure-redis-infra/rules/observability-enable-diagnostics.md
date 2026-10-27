---
title: Enable Azure Monitor Metrics and Connection Logs
impact: MEDIUM
impactDescription: improves operational visibility and auditing
tags: observability, azure-monitor, diagnostics, logging
---

## Enable Azure Monitor Metrics and Connection Logs

Azure Managed Redis exposes the `AllMetrics` cache-metrics category and `ConnectionEvents` connection-log category through Azure Monitor diagnostic settings. Send these signals to Log Analytics or storage for alerting and auditing. The public monitoring reference lists metrics such as `usedmemorypercentage`, `serverLoad`, `percentProcessorTime`, `connectedclients`, `cacheLatency`, `evictedkeys`, and `geoReplicationHealthy` for geo-replicated caches. Check the current Azure Monitor schema for the target resource when configuring diagnostics. For private deployments, include private endpoint and private DNS health in the operational view so a cache health issue is not confused with name-resolution or network reachability failure.

**Incorrect (no diagnostics enabled):**

```text
Diagnostic settings: Disabled
Metrics: Not exported
Connection logs: Off
```

**Correct (metrics and connection logs enabled):**

```text
Diagnostic settings: Enabled
Categories: AllMetrics, ConnectionEvents
Destination: Log Analytics workspace
Signals: Used Memory Percentage, CPU, Server Load, Cache Latency, Connected Clients, Evicted Keys
Network checks: private endpoint connection state and private DNS resolution
```

Reference: [Monitor diagnostics for Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/monitor-diagnostic-settings)
