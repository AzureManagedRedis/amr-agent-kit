# AMR Agent Kit Gemini Extension

This extension provides agent skills for Redis and Azure Managed Redis. It covers Redis application and AI coding patterns plus Azure Managed Redis infrastructure guidance.

## Installation

Install via the skills CLI:

```bash
npx skills add AzureManagedRedis/amr-agent-kit
```

Or copy this repository into your Gemini extension configuration directory.

## Usage

Once installed, the skills are available when Gemini detects Redis or Azure Managed Redis tasks. Example prompts:

- "Review my Redis usage for Azure Managed Redis best practices"
- "Help me choose Redis data structures and key names for this feature"
- "Design a Redis vector search index for my RAG pipeline"
- "Add semantic caching or LLM memory with Redis on Azure Managed Redis"
- "Plan a secure Azure Managed Redis deployment with Private Link, Entra ID, and monitoring"

## Skill Categories

| Skill | Focus |
|---|---|
| `redis-code` | Redis application and AI coding patterns, including data structures, key design, commands, caching, sessions, messaging, memory, resilience, vector search, RAG, semantic caching, LLM memory, agent state, embeddings, and framework integration |
| `azure-redis-infra` | Azure Managed Redis provisioning, networking, security, availability, geo-replication, durability, performance, and observability |
