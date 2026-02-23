---
title: Avoid Keyspace Notifications for Critical Workflows
impact: MEDIUM-HIGH
impactDescription: prevents missed events in production
tags: keyspace, notifications, reliability, pubsub
---

## Avoid Keyspace Notifications for Critical Workflows

Keyspace notifications are best-effort Pub/Sub events and can be missed under load or during failover. Do not use them as the sole trigger for critical workflows; use Streams or a durable queue for guaranteed processing.

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

Reference: [Redis keyspace notifications](https://redis.io/docs/latest/develop/notify/keyspace-events/)
