---
title: Select Redis Modules at Provisioning Time
impact: CRITICAL
impactDescription: avoids reprovisioning when modules are required
tags: modules, provisioning, redisearch, redisjson
---

## Select Redis Modules at Provisioning Time

Azure Managed Redis requires modules (RediSearch, RedisJSON, etc.) to be enabled during cache creation. You can't add modules after the instance is created, so plan module requirements early to avoid rebuilding or migrating the cache later.

**Incorrect (enable modules after creation):**

```text
Create cache: Modules = none
Later requirement: Enable RediSearch
Result: must rebuild a new cache
```

**Correct (enable required modules at creation):**

```text
Create cache: Modules = RediSearch, RedisJSON
Cluster policy: Enterprise
Result: vector search and JSON features available
```

Reference: [Create Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/quickstart-create-managed-redis)
