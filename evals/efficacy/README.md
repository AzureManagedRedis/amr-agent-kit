# AMR Agent Kit Efficacy Evals

These evals measure whether AMR Agent Kit adds value when a skill is loaded. They are intentionally separate from routing evals:

- **Routing evals** answer: did the model choose the right skill?
- **Efficacy evals** answer: when the right skill is loaded, does the answer improve?

## Hardening from Iteration 1

The first paired sample showed that baseline answers were already strong on generic Redis, RAG, Azure networking, and reliability prompts. That historical sample predates the current definitions for evals 11–18 and does not validate those exact rubrics. To make future runs more discriminating, the prompts use review-style scenarios with plausible but unsafe design choices. The goal is to check whether the loaded AMR skill catches details that a strong general model often misses.

Key changes:

- The cache-stampede eval now tests Azure Managed Redis client safeguards directly: service-returned host and port (`10000` by default), TLS or `rediss`, certificate validation, connection reuse, timeouts, bounded retries, and fail-fast configuration checks.
- The RAG eval keeps the tenant-isolation case because it showed useful uplift, but now adds harder checks for AMR vector prerequisites, idempotent ingestion, source citations, and semantic-cache boundaries.
- The Private Link/DNS eval now includes traps around direct `privatelink` host usage, hub-only DNS links, VNet peering DNS assumptions, `publicNetworkAccess`, `redisEnterprise` private endpoint metadata, and route/firewall validation.
- The HA/DR eval now distinguishes persistence, export backup, zone resilience, and active geo-replication with AMR-specific incompatibilities and provisioning-time decisions.

## Azure Ecosystem Coverage

The corpus also includes scenarios that test whether AMR guidance composes cleanly with common Azure application platforms and operational services:

- **AKS + Entra + Key Vault + App Configuration** - verifies managed identity/workload identity, AMR data access policies, token refresh, and secretless client configuration.
- **Azure Monitor + Application Insights + Log Analytics** - verifies discovery and use of the deployed resource's supported metric/log categories, action groups, runbooks, replication alerts, and app dependency correlation without inventing public metric names.
- **Event Grid + Service Bus + Azure Functions** - verifies safe cache invalidation, idempotent event handling, dead-letter/replay behavior, and durable downstream messaging.
- **Blob Storage + Event Grid + Azure AI + AMR vector search** - verifies idempotent RAG ingestion, Azure AI embedding/version boundaries, citation metadata, semantic-cache scoping, and Azure-native connectivity.
- **Metric-based AMR sizing** - verifies SKU guidance uses peak/P95 memory, server load, connected clients, bandwidth, module needs, regional availability, and preview status rather than legacy/source SKU labels.
- **Native AMR IaC** - verifies ARM/Bicep and Terraform guidance uses the Azure Managed Redis cluster/database/default-database model, service-returned connection data, cloud-specific Private Link DNS, and deployment preflight checks.
- **Tenant key and cluster design** - verifies Redis application guidance prefers key prefixes for portable tenant separation and explains documented multi-key behavior by cluster policy without asserting unsupported logical-database behavior.
- **Tenant isolation infrastructure** - verifies infrastructure guidance distinguishes key naming from access control, scopes data permissions, and recommends separate AMR caches when a stronger resource-level isolation boundary is required.
- **Correctness and no-harm gates** - evals 13–18 use `minimum_uplift: 0`; they check that answers avoid specific harmful or incorrect recommendations and are not, by themselves, evidence of skill uplift. They cover service-returned ports, the `minimumTlsVersion` value, module compatibility, automatic zone redundancy with high availability in supported regions, SKU/eviction/memory monitoring, and the documented five-instance active geo-replication limit.

These scenarios should expose whether the skill adds value beyond standalone Redis advice by requiring the answer to connect AMR practices with surrounding Azure services.

## Method

Run each prompt twice with the same model:

1. **without_skill** - the prompt only, with no AMR skill file in context.
2. **with_skill** - the same prompt after force-loading the target skill's `AGENTS.md`.

Grade both outputs against the same expectations in `evals.json`. For one answer, the expectation score is the number of passed expectations divided by the total expectations. Report anti-patterns separately; a high expectation score does not offset an anti-pattern.

## Pass Criteria

For efficacy cases with a positive `minimum_uplift`, compare paired outputs from the same model and prompt. The with-skill expectation score should meet `minimum_skill_score` and exceed the without-skill score by at least `minimum_uplift`. Anti-patterns in the with-skill answer make the pair fail.

With only one answer per model and condition, these are descriptive paired results, not statistically conclusive pass-rate estimates. Thresholds also have coarse granularity: for example, five binary expectations and a `minimum_skill_score` of `0.85` require all five expectations to pass.

Cases 13–18 have `minimum_uplift: 0` and are correctness/no-harm gates. Report their with-skill correctness and anti-pattern results alongside the baseline; do not present their scores as evidence that the skill improves answers over baseline.

## Suggested Runner Layout

Use the skill-creator workspace layout so its benchmark aggregator and review viewer can read results:

```text
amr-agent-kit-efficacy-workspace/
  iteration-1/
    eval-1-redis-cache-stampede/
      eval_metadata.json
      with_skill/
        run-1/
          outputs/answer.md
          grading.json
          timing.json
      without_skill/
        run-1/
          outputs/answer.md
          grading.json
          timing.json
```

Use `skill-creator/eval-viewer/generate_review.py` with `--static` in headless environments so reviewers can inspect qualitative outputs and benchmark results.

## Grading Guidance

Each `expectations` entry should be graded as pass/fail based on evidence in the answer. Keep the grading strict:

- Pass only when the answer gives actionable, AMR-relevant guidance.
- Fail when the answer only mentions the topic generically.
- Fail when an anti-pattern appears, even if nearby text is partly correct.
- Fail when the answer agrees with a flawed proposal without explicitly correcting it.
- Prefer evidence tied to AMR-specific details over broad Azure or Redis best practices.

This keeps the benchmark focused on value beyond generic Redis or Azure knowledge.
