"""Dependency-free executable fixture for deterministic bad-pattern patches."""

from pathlib import Path
import json


def read_policy() -> dict[str, str]:
    lines = (Path(__file__).with_name("invariants.txt")).read_text(encoding="utf-8").splitlines()
    return dict(line.split("=", 1) for line in lines if line)


if __name__ == "__main__":
    policy = read_policy()
    print(json.dumps({
        "fixture": "retained-soak-client",
        "status": "reference-good" if all(not value.startswith(("disabled", "none", "retry-forever", "create-", "startup-", "redis://", "del-", "KEYS-", "SELECT-", "unrelated-", "pubsub-", "no-", "blind-", "post-", "global-", "best-")) for value in policy.values()) else "mutated",
        "policy": policy,
    }, separators=(",", ":"), sort_keys=True))
