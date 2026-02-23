---
title: Persist Agent State and Checkpoints in Redis
impact: MEDIUM-HIGH
impactDescription: enables recovery and observability for agent runs
tags: agents, state, checkpoints, reliability
---

## Persist Agent State and Checkpoints in Redis

Store agent run state (plan, current step, tool outputs, status) in Redis so workflows can resume after failures or restarts. In-memory-only state makes agent execution brittle in distributed systems.

**Incorrect (state only in process memory):**

```python
agent_state = {"run_id": run_id, "step": "retrieve", "status": "running"}
```

**Correct (durable state in Redis):**

```python
redis_client.hset(
    f"agent:run:{run_id}",
    mapping={
        "step": "retrieve",
        "status": "running",
        "lastTool": "vector_search",
        "updatedAt": "2026-02-18T10:15:00Z"
    }
)
redis_client.expire(f"agent:run:{run_id}", 86400)
```

Reference: [Redis AI patterns](https://redis.io/docs/latest/develop/ai/)
