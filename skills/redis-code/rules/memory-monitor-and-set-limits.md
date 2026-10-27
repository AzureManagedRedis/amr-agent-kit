---
title: Monitor Memory and Choose Capacity and Eviction
impact: CRITICAL
impactDescription: prevents out-of-memory crashes and performance degradation
tags: memory, monitoring, maxmemory, eviction
---

## Monitor Memory and Choose Capacity and Eviction

Azure Managed Redis derives the database memory limit from the selected tier/SKU; clients cannot set `maxmemory` with `CONFIG SET`. Size the cache with headroom, choose the eviction policy through the AMR resource configuration, and monitor memory usage, fragmentation, evictions, and rejected writes.

**Incorrect (try to manage AMR capacity from a Redis client):**

```python
r.config_set("maxmemory", "20gb")  # Rejected: AMR manages this from the SKU
```

**Correct (monitor the service-managed limit):**

```python
import redis
r = redis.Redis(
    host='mycache.eastus.redis.azure.net',
    port=10000,
    ssl=True,
    decode_responses=True
)
# Check current memory configuration
info = r.info("memory")
print(f"Used memory: {info['used_memory_human']}")
print(f"Peak memory: {info['used_memory_peak_human']}")
print(f"Max memory: {info.get('maxmemory_human', 'not set')}")
print(f"Eviction policy: {info.get('maxmemory_policy', 'noeviction')}")

# Memory monitoring function
def check_memory_health(r, warning_threshold=0.8, critical_threshold=0.95):
    """Check Redis memory status"""
    info = r.info("memory")

    used = info["used_memory"]
    max_mem = info.get("maxmemory", 0)

    if max_mem == 0:
        return {"status": "warning", "message": "memory limit was not reported"}

    ratio = used / max_mem

    if ratio > critical_threshold:
        return {
            "status": "critical",
            "message": f"Memory at {ratio:.1%} of limit",
            "used": used,
            "max": max_mem
        }
    elif ratio > warning_threshold:
        return {
            "status": "warning",
            "message": f"Memory at {ratio:.1%} of limit"
        }
    else:
        return {"status": "ok", "ratio": ratio}

# Check for evicted keys
def check_eviction_rate(r):
    """Monitor key eviction"""
    stats = r.info("stats")
    evicted = stats.get("evicted_keys", 0)

    if evicted > 0:
        return {
            "status": "warning",
            "evicted_keys": evicted,
            "message": "Keys are being evicted - review capacity and eviction policy"
        }
    return {"status": "ok", "evicted_keys": 0}

# Find large keys consuming memory
def find_large_keys(r, sample_size=1000, top_n=10):
    """Sample keys and find largest by memory usage"""
    large_keys = []
    cursor = 0
    sampled = 0

    while sampled < sample_size:
        cursor, keys = r.scan(cursor, count=100)
        for key in keys:
            memory = r.memory_usage(key)
            if memory:
                large_keys.append((key, memory))
            sampled += 1
        if cursor == 0:
            break

    # Sort by memory usage descending
    large_keys.sort(key=lambda x: x[1], reverse=True)
    return large_keys[:top_n]

# Memory usage by key pattern
def memory_by_pattern(r, patterns, sample_per_pattern=100):
    """Estimate memory usage by key pattern"""
    results = {}

    for pattern in patterns:
        total_memory = 0
        count = 0

        for key in r.scan_iter(match=pattern, count=100):
            memory = r.memory_usage(key) or 0
            total_memory += memory
            count += 1
            if count >= sample_per_pattern:
                break

        results[pattern] = {
            "sampled_count": count,
            "total_memory": total_memory,
            "avg_per_key": total_memory / count if count > 0 else 0
        }

    return results

# Example: Check memory health
health = check_memory_health(r)
if health["status"] != "ok":
    print(f"Memory alert: {health['message']}")
    large = find_large_keys(r)
    print(f"Largest keys: {large}")
```

Select an AMR SKU whose usable memory covers peak or P95 demand plus fragmentation and replication headroom. Choose an appropriate eviction policy through the service configuration: for example, a TTL-aware policy for cache data or `noeviction` when writes must fail rather than discard keys. Do not issue client-side `CONFIG SET maxmemory` or `CONFIG SET maxmemory-policy`; monitor the effective values and scale through Azure when required.

Reference: [Redis Memory Management](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/)
