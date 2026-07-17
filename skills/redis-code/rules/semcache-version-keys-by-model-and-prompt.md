---
title: Version Semantic Cache Keys by Model and Prompt
impact: HIGH
impactDescription: avoids stale or incompatible cached generations
tags: semantic-cache, key-design, model-version, prompt-version
---

## Version Semantic Cache Keys by Model and Prompt

Include model ID, prompt template version, tenant, ACL/policy boundary, embedding model, and knowledge-base version in semantic cache keys. Reusing cache entries across model, prompt, policy, or corpus changes can return outdated or unauthorized answers.

**Incorrect (cache key misses versioning dimensions):**

```text
cache_key = "semcache:{query_embedding_hash}"
```

**Correct (cache key includes generation contract):**

```text
cache_key = "semcache:{tenant}:{aclHash}:{llmModel}:{embeddingModel}:{promptVersion}:{kbVersion}:{query_embedding_hash}"
```

Reference: [RedisVL for AI application patterns](https://redis.io/docs/latest/develop/ai/redisvl/)
