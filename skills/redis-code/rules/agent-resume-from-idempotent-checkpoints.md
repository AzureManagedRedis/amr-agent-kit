---
title: Resume Agents from Idempotent Checkpoints
impact: MEDIUM-HIGH
impactDescription: prevents repeated side effects after worker restarts
tags: agents, checkpoints, recovery, idempotency, reliability
---

## Resume Agents from Idempotent Checkpoints

Persist each agent step as an idempotent checkpoint with its output location and status. On restart, load the latest checkpoint and skip completed tool calls instead of replaying the whole plan and repeating side effects.

**Incorrect (restart repeats completed tool calls):**

```python
for step in plan.steps:
    output = call_tool(step.name, step.input)
    memory.append({"step": step.name, "output": output})
```

**Correct (resume from recorded step completion):**

```python
checkpoint_key = f"agent:run:{run_id}:checkpoint"
to_text = lambda value: value.decode() if isinstance(value, bytes) else value
state = {to_text(key): to_text(value) for key, value in redis_client.hgetall(checkpoint_key).items()}

for step in plan.steps:
    if state.get(step.name) == "done":
        output = redis_client.get(f"agent:run:{run_id}:output:{step.name}")
        continue

    idempotency_key = f"{run_id}:{step.name}"
    output = call_tool(step.name, step.input, idempotency_key=idempotency_key)

    pipe = redis_client.pipeline()
    pipe.set(f"agent:run:{run_id}:output:{step.name}", output, ex=86400)
    pipe.hset(checkpoint_key, mapping={step.name: "done", "last_step": step.name})
    pipe.expire(checkpoint_key, 86400)
    pipe.execute()
```

Reference: [Redis AI patterns](https://redis.io/docs/latest/develop/ai/)
