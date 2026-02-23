# redis-agent-skills

A collection of skills for AI coding agents working with Redis and Azure Managed Redis. Skills are packaged instructions and scripts that extend agent capabilities.

Skills follow the [Agent Skills](https://agentskills.io/) format.

## Available Skills

### redis-best-practices

Redis development guidelines containing 30+ rules across 10 categories, prioritized by impact.

**Use when:**
- Writing new code that interacts with Redis
- Designing key schemas and data structures
- Reviewing Redis usage for reliability and performance
- Implementing caching, messaging, and rate limiting

### redis-ai-patterns

AI application patterns for Redis on Azure Managed Redis, including vector search and RAG.

**Use when:**
- Building vector-search or RAG workflows
- Implementing semantic caching
- Designing LLM memory and agent state
- Choosing module and cluster policy for AI workloads

### azure-infra

Azure Managed Redis infrastructure patterns for provisioning, security, reliability, and operations.

**Use when:**
- Provisioning and sizing Azure Managed Redis
- Configuring networking, security, and access
- Planning HA, geo-replication, and durability
- Enabling diagnostics and operational guardrails

## Installation

```bash
npx skills add redis/redis-agent-skills
```

## Usage

Skills are loaded on-demand. The agent activates relevant skills based on the task.

**Examples:**
```
Review my Redis key design and caching logic
```
```
Help me set up Azure Managed Redis with private endpoints
```
```
Optimize this Redis vector search workflow
```

## Skill Structure

Each skill contains:
- `SKILL.md` - Instructions for the agent (activation + quick reference)
- `AGENTS.md` - Compiled guidance (generated output)
- `rules/` - Individual rule files
- `metadata.json` - Version and metadata

## Building

```bash
cd packages/redis-best-practices-build
npm install
npm run build
npm run build-best-practices
npm run build-ai
npm run build-azure-infra
npm run validate
```

## Compatibility

Works with Claude Code, GitHub Copilot, Gemini CLI, and other Agent Skills-compatible tools.

## License

MIT
