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
