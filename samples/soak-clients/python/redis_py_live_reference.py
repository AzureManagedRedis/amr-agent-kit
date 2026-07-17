"""Enable only in a consumer environment that separately supplies redis-py."""

from redis import Redis


def connect(endpoint: str, timeout_ms: int) -> Redis:
    return Redis.from_url(
        endpoint,
        ssl_cert_reqs="required",
        socket_connect_timeout=timeout_ms / 1000,
        socket_timeout=timeout_ms / 1000,
        retry_on_timeout=False,
    )


def run_probe(client: Redis, namespace: str, run_id: str, scenario: str, ttl_seconds: int) -> None:
    probe_key = f"{namespace}:{run_id}:{scenario}:probe"
    teardown_key = f"{namespace}:{run_id}:{scenario}:teardown"
    try:
        client.set(probe_key, "1", ex=ttl_seconds)
    finally:
        client.delete(probe_key, teardown_key)
