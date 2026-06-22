---
title: Isolate Local and Test Redis Configuration
impact: MEDIUM-HIGH
impactDescription: prevents tests and local tools from mutating production Redis data
tags: resilience, testing, configuration, safety, environment
---

## Isolate Local and Test Redis Configuration

Keep local development and automated tests isolated from Azure Managed Redis production instances. Tests should require explicit test configuration, use disposable namespaces, and clean only their own keys. Never let missing local settings fall back to production endpoints or credentials.

**Incorrect (tests can hit production and flush data):**

```javascript
import { createClient } from "redis";

const client = createClient({
  url: process.env.REDIS_URL || "rediss://prod-cache.eastus.redis.azure.net:10000"
});

beforeEach(async () => {
  await client.connect();
  await client.flushAll();
});
```

**Correct (explicit test endpoint and namespaced cleanup):**

```javascript
import { randomUUID } from "node:crypto";
import { createClient } from "redis";

if (process.env.NODE_ENV === "test" && !process.env.TEST_REDIS_URL) {
  throw new Error("TEST_REDIS_URL is required for Redis integration tests");
}

const keyPrefix = `test:${randomUUID()}:`;
const client = createClient({ url: process.env.TEST_REDIS_URL });

export function testKey(name) {
  return `${keyPrefix}${name}`;
}

beforeAll(async () => {
  await client.connect();
});

afterEach(async () => {
  for await (const key of client.scanIterator({ MATCH: `${keyPrefix}*`, COUNT: 100 })) {
    await client.del(key);
  }
});

afterAll(async () => {
  await client.quit();
});
```

Use separate resource groups, databases, credentials, or local containers for test workloads when possible. Block destructive commands such as `FLUSHALL` and `FLUSHDB` against shared Azure Managed Redis environments, and require production configuration to be explicit at startup.

References:
- [Redis SCAN command](https://redis.io/docs/latest/commands/scan/)
- [Azure Managed Redis overview](https://learn.microsoft.com/en-us/azure/redis/overview)
