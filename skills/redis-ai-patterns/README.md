# Redis AI Patterns Skill

An [Open Agent Skill](https://agentskills.io/) for building AI applications with Redis on Azure Managed Redis.

## Overview

This skill helps AI agents design Redis-backed AI and ML workloads. It contains 24 rules across 9 categories covering vector storage, similarity search, RAG, semantic caching, LLM memory, agent state, embeddings, framework integration, and performance tuning.

Use this skill for:

- Vector search schema and index design
- Retrieval augmented generation (RAG) pipelines
- Semantic caching for LLM responses
- LLM memory, sessions, and conversation summarization
- Durable AI agent state and checkpoint storage
- RedisVL, LangChain, LlamaIndex, Semantic Kernel, Microsoft Agent Framework, and Redis AI ecosystem integration

## Usage

Load this skill into an AI agent that supports Open Agent Skills. The agent should activate it when a user asks about embeddings, similarity search, vector databases, RAG, semantic caching, LLM memory, or AI agents on Azure Managed Redis.

### With GitHub Copilot CLI

Install the full AMR Agent Kit, then reload skills:

```bash
npx skills add AzureManagedRedis/amr-agent-kit -g -a github-copilot
```

```text
/skills reload
/skills info redis-ai-patterns
```

### Manual Copy

Copy this folder into the target agent's skills directory:

```text
skills/redis-ai-patterns/
```

## Example Prompts

### Vector Search and RAG

- **"Design a Redis vector index for a RAG knowledge base."**
- **"Help me store embeddings with metadata for hybrid retrieval."**
- **"Review this Redis vector query for latency and relevance."**

### Semantic Caching and LLM Memory

- **"Implement semantic caching for LLM prompts using Redis."**
- **"Design conversation memory with TTLs and sliding windows."**
- **"Summarize older turns to keep LLM context under control."**

### AI Agents and Frameworks

- **"Persist agent state and checkpoints in Redis."**
- **"Use Redis Streams for multi-step agent workflows."**
- **"Integrate RedisVL or Microsoft Agent Framework with Azure Managed Redis."**

## Skill Structure

```text
redis-ai-patterns/
+-- SKILL.md
+-- README.md
+-- metadata.json
+-- AGENTS.md
+-- rules/
    +-- _sections.md
    +-- _template.md
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
| 1 | Vector Storage & Indexing | CRITICAL | `vec-` |
| 2 | Similarity Search | CRITICAL | `search-` |
| 3 | RAG Implementation | HIGH | `rag-` |
| 4 | Semantic Caching | HIGH | `semcache-` |
| 5 | LLM Memory & Sessions | HIGH | `llm-` |
| 6 | AI Agent Patterns | MEDIUM-HIGH | `agent-` |
| 7 | Embeddings & Models | MEDIUM | `embed-` |
| 8 | Framework Integration | MEDIUM | `integrate-` |
| 9 | Performance Tuning | LOW-MEDIUM | `perf-` |

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
npm run build-ai
npm run validate
```

## External Resources

This skill references Azure Managed Redis, Redis AI, and framework documentation, including:

- [Azure Managed Redis overview](https://learn.microsoft.com/en-us/azure/redis/overview)
- [Azure Managed Redis architecture](https://learn.microsoft.com/en-us/azure/redis/architecture)
- [Redis AI documentation](https://redis.io/docs/latest/develop/ai/)
- [Redis vector search documentation](https://redis.io/docs/latest/develop/ai/search-and-query/vectors/)
- [RedisVL documentation](https://redis.io/docs/latest/develop/ai/redisvl/)
- [Microsoft Agent Framework](https://learn.microsoft.com/en-us/agent-framework/)

## Contributing

1. Keep rules focused on AI workloads that use Redis or Azure Managed Redis.
2. Use existing category prefixes and naming conventions.
3. Update examples when Redis AI, Azure Managed Redis, or framework guidance changes.
4. Rebuild generated guidance before opening a pull request.

## License

MIT
