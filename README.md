# AMR Agent Kit

A collection of [Open Agent Skills](https://agentskills.io/) for AI coding agents working with Redis and Azure Managed Redis (AMR).

## Overview

This repository helps AI agents provide Azure Managed Redis guidance through two focused skills:

- Use `redis-code` for Redis application and AI coding patterns: data structures, key design, caching, messaging, vector search, RAG, semantic caching, LLM memory, and agent state.
- Use `azure-redis-infra` for Azure Managed Redis infrastructure: provisioning, Private Link, security, availability, geo-replication, durability, performance, and observability.

### Migration to Azure Managed Redis

Migration guidance is maintained in separate skills, not bundled with this kit:

| Source service/tier | Migration skill and installation instructions |
|---|---|
| Azure Cache for Redis Basic, Standard, or Premium (ACR/OSS) | [amr-migration-skill](https://github.com/AzureManagedRedis/amr-migration-skill#usage) |
| Azure Cache for Redis Enterprise or Enterprise Flash (ACRE) | [acre-to-amr-migration-skill](https://github.com/AzureManagedRedis/acre-to-amr-migration-skill#usage) |

For migration help, use the skill matching your source service/tier. If the source is unclear, the agent should ask before choosing a skill.

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

### redis-code

Redis application and AI coding best practices optimized for Azure Managed Redis.

Use when writing, reviewing, or refactoring Redis code on AMR, including caching, session storage, pub/sub, queues, leaderboards, rate limiting, data structures, key design, vector search, RAG, semantic caching, LLM memory, embeddings, and AI agent state.

### azure-redis-infra

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
|   +-- redis-code/
|   |   +-- SKILL.md
|   |   +-- README.md
|   |   +-- metadata.json
|   |   +-- AGENTS.md
|   |   +-- rules/
|   +-- azure-redis-infra/
|   |   +-- SKILL.md
|   |   +-- README.md
|   |   +-- metadata.json
|   |   +-- AGENTS.md
|   |   +-- rules/
+-- packages/
    +-- amr-agent-skills-build/
```

Each skill contains:

- `SKILL.md` - Agent-facing activation, scope, workflow, and quick-reference guidance.
- `README.md` - Human-facing usage, structure, and maintenance notes.
- `AGENTS.md` - Compact generated catalog linking to individual rule files.
- `rules/` - Individual rule files with examples, impact, and references.
- `metadata.json` - Version, publication metadata, abstract, and reference links.

## Building and Validation

```bash
cd packages/amr-agent-skills-build
npm install
npm run build
npm run build-redis-code
npm run build-azure-redis-infra
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

Do not report security vulnerabilities in public issues; follow [SECURITY.md](SECURITY.md).

## Contributing

1. Keep skill content aligned with Azure Managed Redis and Redis documentation.
2. Add or update rule files under the appropriate skill's `rules/` directory.
3. Rebuild generated `AGENTS.md` files after changing rules.
4. Run validation before opening a pull request.

### Contributor License Agreement and code of conduct

This project welcomes contributions and suggestions.  Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit [Contributor License Agreements](https://cla.opensource.microsoft.com).

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Compatibility

Works with GitHub Copilot CLI, Claude Code, Gemini CLI, and other Open Agent Skills-compatible tools.

## License

MIT
