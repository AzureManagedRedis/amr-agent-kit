---
title: Set TTL and Sliding Windows for LLM Session Memory
impact: HIGH
impactDescription: controls memory growth and stale context risk
tags: llm-memory, sessions, ttl, context-window
---

## Set TTL and Sliding Windows for LLM Session Memory

Conversation memory should use TTL and bounded history windows. Unlimited session retention increases cost, latency, and chance of stale context impacting responses.

**Incorrect (unbounded session history):**

```python
for turn in conversation:
    redis_client.rpush(f"chat:{session_id}", turn)
# no trim, no expiration
```

**Correct (bounded memory with expiration):**

```python
key = f"chat:{session_id}"
redis_client.rpush(key, turn_json)
redis_client.ltrim(key, -50, -1)
redis_client.expire(key, 3600)
```

Reference: [Azure Managed Redis overview](https://learn.microsoft.com/en-us/azure/redis/overview)
