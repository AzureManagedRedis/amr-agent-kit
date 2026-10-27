---
title: Avoid Keyspace Notifications for Critical Workflows
impact: MEDIUM-HIGH
impactDescription: prevents missed events in production
tags: keyspace, notifications, reliability, pubsub
---

## Avoid Keyspace Notifications for Critical Workflows

Keyspace notifications are best-effort Pub/Sub events and can be missed under load or during failover. Do not use them as the sole trigger for critical workflows; use Streams or a durable queue for guaranteed processing.

On Azure Managed Redis, configure notifications through the database resource's `notifyKeyspaceEvents` property rather than application startup code. Verify the property against the current AMR database resource documentation.

**Incorrect (critical processing based on keyspace notifications):**

```text
Enable keyspace notifications (notify-keyspace-events = Ex)
Trigger billing workflow on expired key event
```

**Correct (use Streams for durable processing):**

```text
Publish workflow events to a Redis Stream
Consume with consumer groups and retry pending entries
```

References:
- [Redis keyspace notification delivery semantics](https://redis.io/docs/latest/develop/pubsub/keyspace-notifications/)
- [AMR `notifyKeyspaceEvents` property](https://learn.microsoft.com/en-us/azure/templates/microsoft.cache/redisenterprise/databases)
