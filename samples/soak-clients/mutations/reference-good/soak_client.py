"""Dependency-free executable fixture for deterministic bad-pattern patches."""

from pathlib import Path
import json
import os
import re

NAMESPACE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:_-]*$")


def read_policy() -> dict[str, str]:
    lines = (Path(__file__).with_name("invariants.txt")).read_text(encoding="utf-8").splitlines()
    return dict(line.split("=", 1) for line in lines if line)


def is_reference_good(policy: dict[str, str]) -> bool:
    unsafe_prefixes = ("disabled", "none", "retry-forever", "create-", "startup-", "redis://", "del-", "KEYS-", "SELECT-", "unrelated-", "pubsub-", "no-", "blind-", "post-", "global-", "best-")
    return policy.get("flush-operations") == "disabled" and all(
        key == "flush-operations" or not value.startswith(unsafe_prefixes)
        for key, value in policy.items()
    )


if __name__ == "__main__":
    policy = read_policy()
    namespace = os.getenv("SOAK_KEY_NAMESPACE", "soak")
    run_id = os.getenv("SOAK_RUN_ID", "offline")
    scenario = os.getenv("SOAK_SCENARIO", "cache")
    try:
        ttl_seconds = int(os.getenv("SOAK_TTL_SECONDS", "60"))
    except ValueError:
        ttl_seconds = 0
    invalid_config = not NAMESPACE.fullmatch(namespace) or not NAMESPACE.fullmatch(run_id) or ttl_seconds < 1
    status = "invalid-config" if invalid_config else (
        "reference-good" if is_reference_good(policy) else "mutated"
    )
    print(json.dumps({
        "fixture": "retained-soak-client",
        "status": status,
        "keyNamespace": namespace,
        "runId": run_id,
        "scenario": scenario,
        "probeKey": f"{namespace}:{run_id}:{scenario}:probe",
        "teardownKey": f"{namespace}:{run_id}:{scenario}:teardown",
        "ttlSeconds": ttl_seconds,
        "policy": policy,
    }, separators=(",", ":"), sort_keys=True))
