# Routing Eval

Local fixtures for checking whether prompts route to the intended Azure Managed
Redis skill before answer quality is evaluated. This is intentionally secret-free:
it is not wired into CI, does not read repository secrets, and should be run only
with local credentials if a real model-based classifier is added later.

## What is covered

- Redis application and AI coding prompts should route to `redis-code`.
- Azure Managed Redis infrastructure prompts should route to `azure-redis-infra`.
- Broad cross-domain prompts should choose one of those two skills based on whether
  the requested action is primarily code or infrastructure.
- Unrelated prompts should route to `none` so skills do not over-trigger.

The labeled corpus lives in
[`prompts/labeled-prompts.yaml`](prompts/labeled-prompts.yaml). Prompts avoid
using skill names directly so routing depends on each skill description rather
than keyword echo.

## Waza content evals

The content evals force-load a named skill and use the mock executor by default:

```powershell
waza run evals/redis-code/eval.yaml --executor mock
waza run evals/azure-redis-infra/eval.yaml --executor mock
```

These runs should not require Azure credentials, Redis credentials, or cloud
deployment access.

## Skill efficacy checks

The routing fixtures should be paired with with-skill and without-skill content
evals so rule value is measured separately from routing accuracy. Keep the corpus
focused on the two-skill boundary: Redis code and AI application prompts should
not require infrastructure routing, while SKU, Private Link, HA, geo-replication,
persistence, diagnostics, and Azure resource configuration prompts should route
to infrastructure guidance.
