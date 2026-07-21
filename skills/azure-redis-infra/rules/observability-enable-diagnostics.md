---
title: Enable Azure Monitor Metrics and Connection Logs
impact: MEDIUM
impactDescription: improves operational visibility and auditing
tags: observability, azure-monitor, diagnostics, logging
---

## Enable Azure Monitor Metrics and Connection Logs

Azure Managed Redis emits metrics and can expose diagnostic log categories through Azure Monitor. Query the diagnostic categories and metric definitions supported by the deployed resource/API version, enable the available performance and connection/audit signals, and send them to Log Analytics or storage for alerting and auditing. Category names and public metric names can change independently of the data-plane implementation, so do not assume an internal signal name or a category such as `AllMetrics` is available without checking the current Azure Monitor schema. For private deployments, include private endpoint and private DNS health in the operational view so a cache health issue is not confused with name-resolution or network reachability failure.

**Incorrect (no diagnostics enabled):**

```text
Diagnostic settings: Disabled
Metrics: Not exported
Connection logs: Off
```

**Correct (metrics and connection logs enabled):**

```text
Diagnostic settings: Enabled
Categories: supported categories discovered for this resource
Destination: Log Analytics workspace
Signals: memory, CPU/server load, latency, connections, auth, replication where exposed
Network checks: private endpoint connection state and private DNS resolution
```

Reference: [Monitor diagnostics for Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/monitor-diagnostic-settings)
