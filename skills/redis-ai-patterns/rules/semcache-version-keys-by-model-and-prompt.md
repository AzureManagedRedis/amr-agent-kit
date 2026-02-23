---
title: Version Semantic Cache Keys by Model and Prompt
impact: HIGH
impactDescription: avoids stale or incompatible cached generations
tags: semantic-cache, key-design, model-version, prompt-version
---

## Version Semantic Cache Keys by Model and Prompt

Include model ID and prompt template version in semantic cache keys. Reusing cache entries across model or prompt changes can return outdated or style-incompatible answers.

**Incorrect (cache key misses versioning dimensions):**

```text
cache_key = "semcache:{tenant}:{query_embedding_hash}"
```

**Correct (cache key includes generation contract):**

```text
cache_key = "semcache:{tenant}:{model}:{promptVersion}:{query_embedding_hash}"
```

Reference: [RedisVL for AI application patterns](https://redis.io/docs/latest/develop/ai/redisvl/)
