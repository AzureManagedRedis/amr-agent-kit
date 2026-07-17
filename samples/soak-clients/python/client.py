"""redis-py-shaped soak seed with an offline default."""

import json
import os
import re
from dataclasses import asdict, dataclass
from urllib.parse import urlparse

SCENARIOS = {"cache", "stream", "pubsub", "ingestion", "semantic-cache", "checkpoint"}
NAMESPACE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:_-]*$")


@dataclass(frozen=True)
class Result:
    library: str
    mode: str
    scenario: str
    status: str
    keyNamespace: str
    probeKey: str
    metrics: dict[str, int]


def positive(name: str, default: int) -> int | None:
    try:
        value = int(os.getenv(name, str(default)))
        return value if value > 0 else None
    except ValueError:
        return None


def validate_live_endpoint(endpoint: str | None) -> bool:
    parsed = urlparse(endpoint or "")
    return parsed.scheme == "rediss" and parsed.port == 10000 and bool(parsed.hostname)


def main() -> int:
    mode = os.getenv("SOAK_MODE", "dry-run")
    scenario = os.getenv("SOAK_SCENARIO", "cache")
    namespace = os.getenv("SOAK_KEY_NAMESPACE", "soak:offline")
    bounds = [positive("SOAK_TIMEOUT_MS", 750), positive("SOAK_MAX_RETRIES", 3), positive("SOAK_TTL_SECONDS", 60)]
    invalid = mode not in {"dry-run", "live"} or scenario not in SCENARIOS or not NAMESPACE.fullmatch(namespace) or None in bounds
    if mode == "live" and not validate_live_endpoint(os.getenv("REDIS_ENDPOINT")):
        invalid = True

    status = "invalid-config" if invalid else ("live-adapter-required" if mode == "live" else "ok")
    success = int(status == "ok")
    print(json.dumps(asdict(Result("redis-py", mode, scenario, status, namespace, f"{namespace}:{scenario}:probe",
        {"attempted": 1, "succeeded": success, "failed": 1 - success, "latencyMs": 0})), separators=(",", ":")))
    return 2 if invalid else 0


if __name__ == "__main__":
    raise SystemExit(main())
