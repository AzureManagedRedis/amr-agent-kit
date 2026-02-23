---
title: Use Microsoft Agent Framework with Redis for Durable Agent State
impact: MEDIUM
impactDescription: improves agent reliability and restart recovery
tags: microsoft-agent-framework, integration, redis, agent-state
---

## Use Microsoft Agent Framework with Redis for Durable Agent State

When using Microsoft Agent Framework, store long-lived agent context and retrieval/session state in Redis instead of in-memory process state. This keeps multi-step workflows resilient across restarts and scale-out replicas.

**Incorrect (agent state only in memory):**

```python
agent_state = {
    "session_id": session_id,
    "memory": turns,
    "last_step": "retrieve"
}
```

**Correct (persist framework state in Redis):**

```python
state_key = f"maf:session:{session_id}"
redis_client.hset(
    state_key,
    mapping={
        "memory_summary": summary_text,
        "last_step": "retrieve",
        "retrieval_index": "kb-v1"
    }
)
redis_client.expire(state_key, 3600)
```

Reference: [Microsoft Agent Framework documentation](https://learn.microsoft.com/en-us/agent-framework/)
