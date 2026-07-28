---
title: Set Azure Monitor Alert Baselines Before Launch
impact: HIGH
impactDescription: shortens detection and response time
tags: observability, azure-monitor, alerts, metrics, runbooks
---

## Set Azure Monitor Alert Baselines Before Launch

Azure Managed Redis platform metrics are collected automatically, but production readiness requires alert rules, action groups, dashboards, and runbook links before traffic arrives. Discover the public metric names and dimensions exposed by the deployed resource, baseline thresholds from load tests and expected traffic, then alert on saturation, client pressure, latency, evictions, CPU/server load, connection anomalies, persistence/export status, private endpoint/DNS health, and replication status/lag where used. Route supported diagnostic categories to Log Analytics so alerts can be investigated with connection or audit logs and historical metrics.

**Incorrect (dashboards only, no actionable alerts):**

```text
Metrics: viewed manually in portal
Diagnostic settings: disabled
Alerts: none
Action group: none
Runbook: tribal knowledge
Thresholds: not tied to load test or SLO
```

**Correct (launch baseline with alert routing):**

```text
Diagnostic settings: currently supported metric/log categories to Log Analytics
Metric alerts: memory utilization, server/processor load, connections, latency, evictions
Geo alerts: supported replication status and lag metrics when active geo is enabled
Network alerts/checks: private endpoint state and private DNS resolution
Operational drills: restore/export import drill and regional failover drill
Actions: on-call action group with severity, owner, and runbook URL
Review: tune thresholds after load test and first production week
```

Reference: [Monitor Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/monitor-cache), [Azure Managed Redis monitoring data reference](https://learn.microsoft.com/en-us/azure/redis/monitor-cache-reference)
