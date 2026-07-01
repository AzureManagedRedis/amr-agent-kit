---
title: Reuse SDK Clients and Pools
impact: CRITICAL
impactDescription: prevents TLS handshake overhead and connection exhaustion
tags: connection, sdk, pooling, singleton, performance
---

## Reuse SDK Clients and Pools

Create Redis SDK clients, connection multiplexers, or connection pools once at application startup and reuse them for the lifetime of the process. Per-request clients are especially expensive on Azure Managed Redis because each new connection repeats TLS setup, certificate validation, authentication, and server-side connection allocation.

**Incorrect (connect and disconnect on every request):**

```javascript
import { createClient } from "redis";

export async function getUser(req, res) {
  const client = createClient({
    socket: {
      host: process.env.REDIS_HOST,
      port: 10000,
      tls: true
    },
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD
  });

  await client.connect();
  const user = await client.get(`cache:user:${req.params.id}`);
  await client.quit();

  res.json({ user });
}
```

**Correct (singleton client initialized once):**

```javascript
import { createClient } from "redis";

let redisPromise;

export function getRedis() {
  if (!redisPromise) {
    const client = createClient({
      socket: {
        host: process.env.REDIS_HOST,
        port: 10000,
        tls: true,
        connectTimeout: 5000,
        keepAlive: 5000
      },
      username: process.env.REDIS_USERNAME,
      password: process.env.REDIS_PASSWORD
    });

    client.on("error", (err) => {
      console.error("Redis client error", err);
    });

    redisPromise = client.connect().then(() => client);
  }

  return redisPromise;
}

export async function getUser(req, res) {
  const client = await getRedis();
  const user = await client.get(`cache:user:${req.params.id}`);
  res.json({ user });
}
```

Use the idiom for your SDK: a singleton `ConnectionMultiplexer` for StackExchange.Redis, a shared `RedisClient` and reused stateful connections for Lettuce, a process-wide pool for redis-py, and a connected singleton for node-redis or ioredis. Create separate clients only for distinct roles that require it, such as blocking commands, Pub/Sub subscriptions, or isolated credentials.

Initialize shared clients after validating AMR production configuration: normal Azure Managed Redis host, port `10000`, TLS or `rediss://`, certificate validation, connect/socket/command timeouts, and bounded jittered retries. When using Microsoft Entra authentication, keep client reuse coordinated with token refresh so long-lived pooled connections reconnect or re-authenticate before credentials expire.

References:
- [Redis client pools and multiplexing](https://redis.io/docs/latest/develop/clients/pools-and-muxing/)
- [Azure Managed Redis architecture](https://learn.microsoft.com/en-us/azure/redis/architecture)
