---
name: amr-best-practices
description: |
  Monolithic AMR Agent Kit rollup combining Redis application, Redis AI, and
  Azure Managed Redis infrastructure best practices. Use when a task spans
  multiple AMR/Redis domains, when the user asks for comprehensive Azure Managed
  Redis or Redis best practices, or when designing end-to-end architectures that
  include application code, vector/RAG/agent workloads, and Azure deployment or
  operations decisions. Prefer the focused skills for narrow single-domain tasks.
license: MIT
metadata:
  author: Microsoft
  version: "1.0.0"
---

# AMR Best Practices

Monolithic rollup skill for end-to-end Redis and Azure Managed Redis guidance. It combines all current rules from `redis-best-practices`, `redis-ai-patterns`, and `azure-infra` into a single generated guide.

## Scope

- Reviewing an application that uses Redis on Azure Managed Redis across code, AI workload, and infrastructure layers
- Designing end-to-end AMR architectures that include caching, sessions, messaging, vector search, RAG, security, availability, and monitoring
- Producing one consolidated best-practices answer when the user's request is broad or cross-domain
- Auditing a repository or deployment plan for AMR readiness across application, AI, and Azure operations concerns

## Agent Guidance

### Use Focused Skills for Narrow Work

If the request is only about Redis application code, Redis AI patterns, or Azure Managed Redis infrastructure, prefer the focused skill for that domain. Use this rollup when the request crosses boundaries or asks for the full AMR best-practices set.

### Work from the Outside In

For broad architecture reviews, start with workload goals and Azure Managed Redis deployment constraints, then move to data structures, key design, connection handling, AI retrieval correctness, and operational safeguards.

### Apply Critical Rules First

Prioritize creation-time infrastructure decisions, secure connectivity and identity, correct Redis data structures, key design, vector dimensions, similarity search configuration, and RAG citation storage before lower-level tuning.

## Available Resources

- `AGENTS.md` - Full generated rollup with all 76 rules expanded.
- `rules.manifest.json` - Generated source manifest listing focused skill rule inputs.
- `rules/_sections.md` - Rollup category ordering, impact, and descriptions.
- `metadata.json` - Version, abstract, and reference links.

## Source of Truth

Rule content is not copied into this skill. The build tool reads the focused skill rule files and generates this rollup deterministically. Add or update rules in the focused skills, then run `npm run build`.

## Rule Categories by Priority

| Range | Domain | Categories |
|---|---|---|
| 1-10 | Redis application development | Data structures, keys, commands, connections, caching, use cases, messaging, JSON/Search, memory, resilience |
| 11-19 | Redis AI patterns | Vector storage, similarity search, RAG, semantic caching, LLM memory, agents, embeddings, frameworks, AI performance |
| 20-27 | Azure Managed Redis infrastructure | Provisioning, networking, security, availability, geo-replication, durability, cluster policy, observability |

## Quick Reference

### Redis Application Development

- Data structures and key design first: choose the smallest correct Redis type, namespace keys, set TTLs, avoid large keys, and use SCAN instead of KEYS.
- Command and connection efficiency: use pipelining, MGET/MSET, MULTI/EXEC, Lua where appropriate, pooling, timeouts, and identity-aware authentication.
- Production patterns: use cache-aside, stampede protection, sessions with expiration, safe distributed locks, rate limiting, Streams, RedisJSON/Search, memory limits, health checks, and graceful retries.

### Redis AI Patterns

- Retrieval correctness: align embedding dimensions and distance metric, store filterable metadata, limit K and returned fields, and store source citations.
- LLM efficiency: use semantic cache thresholds and TTLs, version cache keys by model and prompt, bound session memory, and summarize long conversations.
- Agent and framework support: persist agent checkpoints, use Streams for multi-step workflows, standardize embedding models per index, and use RedisVL or Microsoft Agent Framework where appropriate.

### Azure Managed Redis Infrastructure

- Provisioning and modules: choose tier/SKU, region, modules, and cluster policy before creating AMR resources.
- Secure access: prefer Private Link, disabled public access, TLS 1.2/1.3, Microsoft Entra authentication, and least-privilege RBAC.
- Operations: plan HA, zone redundancy, active geo-replication, persistence, export backups, Azure Monitor diagnostics, connection auditing, and alerts.

## Full Compiled Document

For complete explanations, examples, and references across all 76 rules, use `AGENTS.md`.
