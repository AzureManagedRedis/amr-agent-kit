# Routing Eval

Local fixtures for checking whether prompts route to the intended Azure Managed
Redis skill before answer quality is evaluated. This is intentionally secret-free:
it is not wired into CI, does not read repository secrets, and should be run only
with local credentials if a real model-based classifier is added later.

## What is covered

- Redis application prompts should route to `redis-best-practices`.
- Redis AI prompts should route to `redis-ai-patterns`.
- Azure Managed Redis infrastructure prompts should route to `azure-infra`.
- Broad cross-domain AMR prompts should route to `amr-best-practices`.
- Unrelated prompts should route to `none` so skills do not over-trigger.

The labeled corpus lives in
[`prompts/labeled-prompts.yaml`](prompts/labeled-prompts.yaml). Prompts avoid
using skill names directly so routing depends on each skill description rather
than keyword echo.

## Waza content evals

The content evals force-load a named skill and use the mock executor by default:

```powershell
waza run evals/amr-best-practices/eval.yaml --executor mock
waza run evals/redis-best-practices/eval.yaml --executor mock
waza run evals/redis-ai-patterns/eval.yaml --executor mock
waza run evals/azure-infra/eval.yaml --executor mock
```

These runs should not require Azure credentials, Redis credentials, or cloud
deployment access.

## Rollup skill

The `amr-best-practices` eval suite covers broad prompts that intentionally span
Redis application, Redis AI, and Azure Managed Redis infrastructure concerns.
Focused prompts should continue to route to the focused skills.
