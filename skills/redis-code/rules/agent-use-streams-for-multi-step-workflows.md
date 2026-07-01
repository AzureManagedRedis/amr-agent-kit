---
title: Use Redis Streams for Multi-Step Agent Workflows
impact: MEDIUM-HIGH
impactDescription: provides durable sequencing and consumer coordination
tags: agents, streams, orchestration, consumer-groups
---

## Use Redis Streams for Multi-Step Agent Workflows

Use Redis Streams and consumer groups for asynchronous agent stages (retrieve, reason, tool-execute, respond). Poll loops and ad-hoc queues are harder to scale and recover.

**Incorrect (manual polling queue):**

```python
while True:
    task = redis_client.lpop("agent:tasks")
    if task:
        process(task)
```

**Correct (streams with consumer groups):**

```python
redis_client.xadd("agent:events", {"stage": "retrieve", "runId": run_id})
redis_client.xgroup_create("agent:events", "workers", id="0", mkstream=True)
events = redis_client.xreadgroup("workers", "worker-1", {"agent:events": ">"}, count=10)
```

Reference: [Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/)
