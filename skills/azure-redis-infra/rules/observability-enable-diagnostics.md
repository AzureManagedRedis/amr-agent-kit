---
title: Enable Azure Monitor Metrics and Connection Logs
impact: MEDIUM
impactDescription: improves operational visibility and auditing
tags: observability, azure-monitor, diagnostics, logging
---

## Enable Azure Monitor Metrics and Connection Logs

Azure Managed Redis emits metrics and diagnostic logs through Azure Monitor. Enable metrics (AllMetrics) and connection logs to capture performance signals and authentication events, and send them to Log Analytics or storage for alerting and auditing.

**Incorrect (no diagnostics enabled):**

```text
Diagnostic settings: Disabled
Metrics: Not exported
Connection logs: Off
```

**Correct (metrics and connection logs enabled):**

```text
Diagnostic settings: Enabled
Categories: AllMetrics, Connection logs
Destination: Log Analytics workspace
```

Reference: [Monitor diagnostics for Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/monitor-diagnostic-settings)
