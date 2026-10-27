---
title: Implement Distributed Locks Safely
impact: CRITICAL
impactDescription: reduces coordination errors and unsafe unlocks
tags: use-cases, locking, distributed, concurrency
---

## Implement Distributed Locks Safely

Use Redis locks for best-effort coordination with unique lock values, TTL expiration, and atomic ownership-checked unlock operations. A lease is not a correctness guarantee: a paused holder can resume after expiry while another client holds the lock. Correctness-critical work needs idempotency or fencing enforced by the protected downstream system, not just a Redis lock.

**Incorrect (unsafe locking patterns):**

```python
import redis
r = redis.Redis(
    host='mycache.eastus.redis.azure.net',
    port=10000,
    ssl=True,
    decode_responses=True
)
# WRONG: No expiration - deadlock if process crashes
r.set("lock:resource", "locked")

# WRONG: Race condition in unlock
if r.get("lock:resource"):
    r.delete("lock:resource")  # May delete another client's lock

# WRONG: Using SETNX without TTL
r.setnx("lock:resource", "1")
```

**Correct (bounded best-effort lease with ownership-checked release):**

```python
import redis
import uuid
import time
r = redis.Redis(
    host='mycache.eastus.redis.azure.net',
    port=10000,
    ssl=True,
    decode_responses=True
)
# Atomic unlock script - only delete if we own the lock
UNLOCK_SCRIPT = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
"""

class DistributedLock:
    def __init__(self, redis_client, name, timeout=10):
        self.redis = redis_client
        self.name = f"lock:{name}"
        self.timeout = timeout
        self.token = None
        self._unlock = redis_client.register_script(UNLOCK_SCRIPT)

    def acquire(self, blocking=True, blocking_timeout=None):
        """Acquire lock with unique token"""
        self.token = str(uuid.uuid4())
        wait_timeout = self.timeout if blocking_timeout is None else blocking_timeout
        end_time = time.monotonic() + wait_timeout

        while True:
            # SET with NX (only if not exists) and EX (expiration)
            if self.redis.set(self.name, self.token, nx=True, ex=self.timeout):
                return True

            if not blocking:
                return False

            if time.monotonic() >= end_time:
                return False

            time.sleep(0.1)

    def release(self):
        """Release lock only if we own it"""
        if self.token:
            self._unlock(keys=[self.name], args=[self.token])
            self.token = None

    def extend(self, additional_time):
        """Extend lock TTL if we still own it"""
        extend_script = """
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("expire", KEYS[1], ARGV[2])
        else
            return 0
        end
        """
        return self.redis.eval(
            extend_script, 1, self.name, self.token, additional_time
        )

    def __enter__(self):
        if not self.acquire():
            raise TimeoutError(f"Could not acquire {self.name}")
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.release()

# Usage with context manager
with DistributedLock(r, "resource:123", timeout=30) as lock:
    # Best-effort coordination; process_resource must tolerate overlapping work.
    process_resource("123")

# Manual usage with timeout
lock = DistributedLock(r, "payment:order:456", timeout=60)
if lock.acquire(blocking_timeout=5):
    try:
        # The payment service must enforce this stable key across all retries.
        process_payment("456", idempotency_key="payment:order:456")
    finally:
        lock.release()
else:
    raise Exception("Could not acquire lock")
```

Always use unique tokens (UUID) to identify lock ownership. Always set TTL to prevent deadlocks. Use Lua scripts for atomic check-and-delete. Fail closed if acquisition times out. Size the TTL for the protected operation and use ownership-checked renewal when work can exceed it; failed renewal means protection is lost and the holder must stop further work. Even successful renewal cannot prevent a later pause past expiry or revoke work already sent downstream. For payments, use a stable, downstream-enforced idempotency key as above; where stale writes must be rejected, require monotonically increasing fencing tokens checked by the protected resource. A UUID ownership token is not a fencing token. Redlock targets multiple independent Redis masters and does not apply to Azure Managed Redis managed HA.

Reference: [Distributed Locks](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/)
