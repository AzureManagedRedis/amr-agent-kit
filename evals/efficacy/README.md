# AMR Agent Kit Efficacy Evals

These evals measure whether AMR Agent Kit adds value when a skill is loaded. They are intentionally separate from routing evals:

- **Routing evals** answer: did the model choose the right skill?
- **Efficacy evals** answer: when the right skill is loaded, does the answer improve?

## Hardening from Iteration 1

The first paired sample showed that baseline answers were already strong on generic Redis, RAG, Azure networking, and reliability prompts. To make future runs more discriminating, the prompts now use review-style scenarios with plausible but unsafe design choices. The goal is to check whether the loaded AMR skill catches details that a strong general model often misses.

Key changes:

- The cache-stampede eval now tests Azure Managed Redis client safeguards directly: TLS or `rediss`, port `10000`, certificate validation, connection reuse, timeouts, bounded retries, and fail-fast configuration checks.
- The RAG eval keeps the tenant-isolation case because it showed useful uplift, but now adds harder checks for AMR vector prerequisites, idempotent ingestion, source citations, and semantic-cache boundaries.
- The Private Link/DNS eval now includes traps around direct `privatelink` host usage, hub-only DNS links, VNet peering DNS assumptions, `publicNetworkAccess`, `redisEnterprise` private endpoint metadata, and route/firewall validation.
- The HA/DR eval now distinguishes persistence, export backup, zone resilience, and active geo-replication with AMR-specific incompatibilities and provisioning-time decisions.

## Azure Ecosystem Coverage

The corpus also includes scenarios that test whether AMR guidance composes cleanly with common Azure application platforms and operational services:

- **AKS + Entra + Key Vault + App Configuration** - verifies managed identity/workload identity, AMR data access policies, token refresh, and secretless client configuration.
- **Azure Monitor + Application Insights + Log Analytics** - verifies AMR diagnostic settings, connection logs, action groups, runbooks, geo-replication alerts, and app dependency correlation.
- **Event Grid + Service Bus + Azure Functions** - verifies safe cache invalidation, idempotent event handling, dead-letter/replay behavior, and durable downstream messaging.
- **Blob Storage + Event Grid + Azure AI + AMR vector search** - verifies idempotent RAG ingestion, Azure AI embedding/version boundaries, citation metadata, semantic-cache scoping, and Azure-native connectivity.
- **Metric-based AMR sizing** - verifies SKU guidance uses peak/P95 memory, server load, connected clients, bandwidth, module needs, regional availability, and preview status rather than legacy/source SKU labels.
- **Native AMR IaC** - verifies ARM/Bicep and Terraform guidance uses the Azure Managed Redis cluster/database/default-database model, Private Link DNS, and deployment preflight checks.
- **DB0 and clustered key design** - verifies Redis application guidance prefers key prefixes for logical separation, makes logical-database availability topology-specific (clustered/CRDB are database-0-only; NoCluster may allow more and must be verified), and makes hash-tag requirements policy-specific for clustered multi-key, transaction, and Lua operations.

These scenarios should expose whether the skill adds value beyond standalone Redis advice by requiring the answer to connect AMR practices with surrounding Azure services.

## Method

Run each prompt twice with the same model:

1. **without_skill** - the prompt only, with no AMR skill file in context.
2. **with_skill** - the same prompt after force-loading the target skill's `AGENTS.md`.

Grade both outputs against the same expectations in `evals.json`. A skill-loaded run should pass the required expectations and show measurable uplift over the baseline.

## Pass Criteria

For this corpus, a useful skill should generally meet both conditions:

- `with_skill` pass rate is at least `minimum_skill_score`.
- `with_skill` pass rate beats `without_skill` by at least `minimum_uplift`.

Also inspect anti-patterns manually. A high-scoring answer that recommends a critical anti-pattern should be treated as a failure.

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
