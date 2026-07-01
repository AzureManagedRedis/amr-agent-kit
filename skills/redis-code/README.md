# Redis Code Best Practices Skill

An [Open Agent Skill](https://agentskills.io/) for Redis application and AI coding patterns on Azure Managed Redis.

## Overview

This skill helps AI agents write, review, and refactor Redis-backed application code. It combines traditional Redis development guidance with AI application patterns so routing has one code-focused skill instead of separate app and AI siblings.

Use this skill for:

- Redis data structure selection
- Key naming, TTL, and cluster hash-tag design
- Redis command patterns, batching, transactions, and Lua scripts
- Connection pooling, TLS, timeouts, retries, and Entra-aware authentication
- Caching, session storage, rate limiting, queues, Pub/Sub, Streams, JSON, Search, and memory optimization
- Vector search, RAG, semantic caching, LLM memory, embedding ingestion, and AI agent state

## Usage

Load this skill into an AI agent that supports Open Agent Skills. The agent should activate it when a user asks about Redis application code, caching, retrieval, vector search, RAG, semantic caching, LLM memory, or agent workflows on Azure Managed Redis.

### With GitHub Copilot CLI

Install the full AMR Agent Kit, then reload skills:

```bash
npx skills add AzureManagedRedis/amr-agent-kit -g -a github-copilot
```

```text
/skills reload
/skills info redis-code
```

### Manual Copy

Copy this folder into the target agent's skills directory:

```text
skills/redis-code/
```

## Example Prompts

### Data Modeling and Key Design

- **"Review this Redis schema and key naming convention."**
- **"Which Redis data structures should I use for users, sessions, counters, and leaderboards?"**
- **"Help me add TTLs and cluster-safe hash tags to these keys."**

### Application Patterns

- **"Refactor this Redis code to use pipelining and MGET/MSET correctly."**
- **"Design a safe distributed lock with expiration and token checks."**
- **"Implement cache-aside with stampede prevention."**

### AI Application Patterns

- **"Design a Redis vector index for this RAG pipeline."**
- **"Add semantic caching with safe thresholds, TTLs, and invalidation."**
- **"Persist agent memory and checkpoints in Redis."**

### Reliability and Operations in Code

- **"Add Redis connection pooling, timeouts, and retries for Azure Managed Redis."**
- **"Review this Redis error handling and health check implementation."**
- **"Help me reduce memory use in this Redis workload."**

## Skill Structure

```text
redis-code/
+-- SKILL.md
+-- README.md
+-- metadata.json
+-- AGENTS.md
+-- rules/
    +-- _sections.md
    +-- _template.md
    +-- ds-*.md
    +-- key-*.md
    +-- cmd-*.md
    +-- conn-*.md
    +-- cache-*.md
    +-- use-*.md
    +-- msg-*.md
    +-- stack-*.md
    +-- memory-*.md
    +-- resilience-*.md
    +-- vec-*.md
    +-- search-*.md
    +-- rag-*.md
    +-- semcache-*.md
    +-- llm-*.md
    +-- agent-*.md
    +-- embed-*.md
    +-- integrate-*.md
    +-- perf-*.md
```

## Rule Categories

| Priority | Category | Impact | Prefix |
|----------|----------|--------|--------|
| 1 | Data Structures | CRITICAL | `ds-` |
| 2 | Key Design | CRITICAL | `key-` |
| 3 | Commands & Patterns | HIGH | `cmd-` |
| 4 | Connection Management | HIGH | `conn-` |
| 5 | Caching Strategies | HIGH | `cache-` |
| 6 | Common Use Cases | MEDIUM-HIGH | `use-` |
| 7 | Pub/Sub & Streams | MEDIUM | `msg-` |
| 8 | JSON & Search | MEDIUM | `stack-` |
| 9 | Memory Optimization | MEDIUM | `memory-` |
| 10 | Error Handling & Resilience | LOW-MEDIUM | `resilience-` |
| 11 | Vector Index Design | CRITICAL | `vec-` |
| 12 | Search Query Patterns | HIGH | `search-` |
| 13 | Retrieval-Augmented Generation | HIGH | `rag-` |
| 14 | Semantic Caching | HIGH | `semcache-` |
| 15 | LLM Memory | MEDIUM-HIGH | `llm-` |
| 16 | AI Agent State | MEDIUM-HIGH | `agent-` |
| 17 | Embedding Pipelines | MEDIUM | `embed-` |
| 18 | Framework Integration | MEDIUM | `integrate-` |
| 19 | AI Performance & Cost | MEDIUM | `perf-` |

## Creating a New Rule

1. Copy `rules/_template.md` to `rules/{prefix}-{description}.md`.
2. Choose the prefix that matches the category in the table above.
3. Fill in frontmatter and content.
4. Include clear incorrect and correct examples with explanations.
5. Run the build to regenerate `AGENTS.md`.

## Building and Validation

From the repository root:

```bash
cd packages/amr-agent-skills-build
npm install
npm run build-redis-code
npm run validate
```

## External Resources

This skill references Azure Managed Redis, Redis developer, and Redis AI documentation, including:

- [Azure Managed Redis overview](https://learn.microsoft.com/en-us/azure/redis/overview)
- [Azure Managed Redis architecture](https://learn.microsoft.com/en-us/azure/redis/architecture)
- [Microsoft Entra authentication for Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication)
- [Redis developer documentation](https://redis.io/docs/latest/develop/)
- [Redis data types](https://redis.io/docs/latest/develop/data-types/)
- [Redis vector search](https://redis.io/docs/latest/develop/ai/search-and-query/vectors/)
- [RedisVL documentation](https://www.redisvl.com/)

## Contributing

1. Keep rules focused on Redis application and AI coding patterns.
2. Use existing category prefixes and naming conventions.
3. Update examples when Azure Managed Redis, Redis clients, or Redis AI framework guidance changes.
4. Rebuild generated guidance before opening a pull request.

## License

MIT
