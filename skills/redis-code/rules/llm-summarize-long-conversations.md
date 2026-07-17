---
title: Summarize Older Turns to Preserve Context Budget
impact: HIGH
impactDescription: improves answer quality for long-running conversations
tags: llm-memory, summarization, context-management
---

## Summarize Older Turns to Preserve Context Budget

For long sessions, summarize older turns and keep recent raw turns. Sending full transcripts on every request increases token cost and may degrade response quality.

**Incorrect (full transcript every request):**

```text
Prompt context = all historical turns (no summarization)
```

**Correct (hybrid memory strategy):**

```text
context = conversation_summary + last_N_turns + retrieved_facts
summary refreshed every 10-20 turns
```

Reference: [Redis AI application patterns](https://redis.io/docs/latest/develop/ai/)
