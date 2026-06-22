# AMR Agent Kit

A collection of [Open Agent Skills](https://agentskills.io/) for AI coding agents working with Redis and Azure Managed Redis (AMR).

## Overview

This repository helps AI agents provide Azure Managed Redis guidance through one monolithic rollup skill plus three focused skills:

- Use `amr-best-practices` for comprehensive or cross-domain AMR/Redis guidance.
- Apply Redis development best practices for data structures, key design, caching, messaging, memory, and resilience.
- Build AI applications on Redis with vector search, RAG, semantic caching, LLM memory, and agent state patterns.
- Provision and operate Azure Managed Redis with Azure-native networking, security, availability, durability, and observability guidance.

## Usage

Load this repository into an AI agent that supports Open Agent Skills. Skills are activated on demand based on the task.

### With GitHub Copilot CLI

#### Option A: Using the Skills CLI

```bash
npx skills add AzureManagedRedis/amr-agent-kit -g -a github-copilot
```

- `-g` installs the skills globally so they are available across projects.
- `-a github-copilot` targets the GitHub Copilot CLI skills directory.

Then reload and verify:

```text
/skills reload
/skills list
```

#### Option B: Clone and Copy

```bash
git clone https://github.com/AzureManagedRedis/amr-agent-kit
```

**Windows (PowerShell):**

```powershell
New-Item -ItemType Directory -Path "$env:USERPROFILE\.copilot\skills" -Force
Copy-Item -Path ".\amr-agent-kit\skills\*" -Destination "$env:USERPROFILE\.copilot\skills\" -Recurse
```

**macOS / Linux:**

```bash
mkdir -p ~/.copilot/skills
cp -r ./amr-agent-kit/skills/* ~/.copilot/skills/
```

Then reload:

```text
/skills reload
```

### With Claude Code

Clone the repo and copy the skill folders into Claude Code's skills directory:

```bash
git clone https://github.com/AzureManagedRedis/amr-agent-kit
mkdir -p ~/.claude/skills
cp -r ./amr-agent-kit/skills/* ~/.claude/skills/
```

## Available Skills

### amr-best-practices

Monolithic AMR rollup skill combining all Redis application, Redis AI, and Azure Managed Redis infrastructure rules.

Use when a task spans multiple AMR/Redis domains or when a user asks for comprehensive best-practices guidance across app code, AI/vector/RAG workloads, and Azure deployment or operations.

### redis-best-practices

Redis development patterns and best practices optimized for Azure Managed Redis.

Use when writing, reviewing, or refactoring application code that interacts with Redis on AMR, including caching, session storage, pub/sub, queues, leaderboards, rate limiting, key-value operations, and data structure selection.

### redis-ai-patterns

Patterns for building AI applications with Redis on Azure Managed Redis.

Use when implementing vector search, RAG, semantic caching, LLM memory, AI agents, embeddings, similarity search, LangChain, LlamaIndex, RedisVL, Microsoft Agent Framework, or vector databases on Azure.

### azure-infra

Azure Managed Redis infrastructure patterns and best practices.

Use when provisioning AMR, configuring private endpoints, enforcing Entra ID authentication and TLS, enabling high availability or geo-replication, setting persistence, and monitoring AMR with Azure Monitor diagnostics.

## Example Prompts

### Redis Application Development

- **"Review my Redis key design and caching logic."**
- **"Help me choose Redis data structures for sessions, counters, and leaderboards."**
- **"Refactor this Redis code to use batching, timeouts, and safer retries."**

### AI Application Patterns

- **"Design a Redis vector search schema for RAG on Azure Managed Redis."**
- **"Help me implement semantic caching with Redis and embeddings."**
- **"Use Redis to persist LLM memory and agent checkpoints."**

### Azure Managed Redis Infrastructure

- **"Help me set up Azure Managed Redis with private endpoints."**
- **"Plan AMR high availability, zone redundancy, and active geo-replication."**
- **"Review my AMR diagnostics, persistence, and security configuration."**

## Skill Structure

```text
amr-agent-kit/
+-- README.md
+-- skills/
|   +-- redis-best-practices/
|   |   +-- SKILL.md
|   |   +-- README.md
|   |   +-- metadata.json
|   |   +-- AGENTS.md
|   |   +-- rules/
|   +-- redis-ai-patterns/
|   |   +-- SKILL.md
|   |   +-- README.md
|   |   +-- metadata.json
|   |   +-- AGENTS.md
|   |   +-- rules/
|   +-- azure-infra/
|   |   +-- SKILL.md
|   |   +-- README.md
|   |   +-- metadata.json
|   |   +-- AGENTS.md
|   |   +-- rules/
|   +-- amr-best-practices/
|   |   +-- SKILL.md
|   |   +-- README.md
|   |   +-- metadata.json
|   |   +-- AGENTS.md
|   |   +-- rules.manifest.json
|   |   +-- rules/
+-- packages/
    +-- amr-agent-skills-build/
```

Each skill contains:

- `SKILL.md` - Agent-facing activation, scope, workflow, and quick-reference guidance.
- `README.md` - Human-facing usage, structure, and maintenance notes.
- `AGENTS.md` - Compiled long-form guidance generated from rule files.
- `rules/` - Individual rule files with examples, impact, and references.
- `metadata.json` - Version, publication metadata, abstract, and reference links.

The `amr-best-practices` rollup generates `AGENTS.md` and `rules.manifest.json` from the focused skill rule directories instead of copying rule files.

## Building and Validation

```bash
cd packages/amr-agent-skills-build
npm install
npm run build
npm run build-amr-best-practices
npm run build-best-practices
npm run build-ai
npm run build-azure-infra
npm run validate
```

## External Resources

These skills reference Azure Managed Redis and Redis documentation, including:

- [Azure Managed Redis overview](https://learn.microsoft.com/en-us/azure/redis/overview)
- [Azure Managed Redis architecture](https://learn.microsoft.com/en-us/azure/redis/architecture)
- [Azure Managed Redis Private Link](https://learn.microsoft.com/en-us/azure/redis/private-link)
- [Microsoft Entra authentication for Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication)
- [Redis developer documentation](https://redis.io/docs/latest/develop/)

## Feedback and Issues

Open an issue in this repository for bugs, missing rules, outdated Azure Managed Redis guidance, or new skill requests.

## Contributing

1. Keep skill content aligned with Azure Managed Redis and Redis documentation.
2. Add or update rule files under the appropriate skill's `rules/` directory.
3. Rebuild generated `AGENTS.md` files after changing rules.
4. Run validation before opening a pull request.

## Compatibility

Works with GitHub Copilot CLI, Claude Code, Gemini CLI, and other Open Agent Skills-compatible tools.

## License

MIT
