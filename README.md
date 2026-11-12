# AMR Agent Kit Public Preview

A collection of [Open Agent Skills](https://agentskills.io/) for AI coding agents working with Redis and Azure Managed Redis (AMR), available in public preview.

[Available Skills](#available-skills) | [Installation](#installation) | [Usage](#usage) | [Support and Feedback](#support-and-feedback)


## Available Skills

This repository helps AI agents provide Azure Managed Redis guidance through two focused skills:

| Skill | Use for |
|---|---|
| [redis-code](skills/redis-code/) | Write, review, or refactor Redis application code on AMR, from client integration to caching and AI application patterns. |
| [azure-redis-infra](skills/azure-redis-infra/) | Provision, configure, and operate AMR, with guidance for infrastructure as code and secure, reliable deployments. |

Together, these skills cover the following areas:

| Area | What the kit helps with |
| --- | --- |
| Application and client code | Review connection reuse, authentication, token refresh, timeouts, retries, and error handling. |
| Data and application patterns | Choose data structures, design keys and expiration, and implement caching, sessions, rate limiting, distributed locks, queues, Pub/Sub, and Streams. |
| Performance and efficiency | Review batching, pipelining, memory use, and latency-sensitive code paths. |
| AI applications | Design vector search, retrieval-augmented generation (RAG), semantic caching, embedding pipelines, conversation memory, and AI agent state. |
| Infrastructure and security | Generate or review ARM templates, Bicep, and Terraform; private connectivity, DNS, identity, and cluster configuration. |
| Reliability and operations | Plan high availability, geo-replication, persistence, backups, monitoring, diagnostic logs, and alerts. |

## Installation

Load this repository into an AI agent that supports Open Agent Skills. Skills are activated on demand based on the task. Choose one installation route per host and scope to avoid loading duplicate copies.

An Azure subscription isn't required to install the skills or review code. Accessing a cache or changing Azure resources requires separately configured tools, authentication, and permissions. Follow your organization's policies for AI assistants and data handling.

### With Skills CLI

With [Node.js](https://nodejs.org/) installed, run the [Skills CLI](https://github.com/vercel-labs/skills) from your target project:

```bash
npx skills add AzureManagedRedis/amr-agent-kit
```

The CLI detects available agents and may prompt you to choose a target. It fetches the skills from GitHub, so you do not need to clone or download this repository first. By default, installation is project-local; add `-g` to make skills available across projects.

### With GitHub Copilot: VS Code Chat and CLI

To target Copilot directly:

```bash
npx skills add AzureManagedRedis/amr-agent-kit -a github-copilot
```

Select either or both skills when prompted. Add `-g` to install globally across projects.

#### Verify in VS Code

1. Open your target project in a current version of VS Code with GitHub Copilot enabled.
2. Run **Chat: Open Customizations** from the Command Palette and check the **Skills** section.
3. Start a fresh Copilot chat. Select **Agent** for tasks that need code changes or tools.
4. Try a [usage prompt](#usage) and inspect skill-loading activity to confirm the relevant instructions are used.

If a skill is missing, check its installation location and that the complete skill folder is present. Reload the VS Code window and start a fresh chat if needed. Available customization controls can vary by VS Code version and organization policy.

#### Verify in Copilot CLI

```text
/skills reload
/skills list
```

### With the Copilot CLI plugin

In a Copilot CLI session, add the marketplace and install the plugin:

```text
/plugin marketplace add AzureManagedRedis/amr-agent-kit
/plugin install amr@amr-agent-kit
```

Or run the same steps from your terminal:

```bash
copilot plugin marketplace add AzureManagedRedis/amr-agent-kit
copilot plugin install amr@amr-agent-kit
```

The `amr` plugin bundles both skills: `redis-code` and `azure-redis-infra`. Check that it's installed with `/plugin list`, then start a new session and run `/skills list`.

### With Claude Code

```bash
npx skills add AzureManagedRedis/amr-agent-kit -a claude-code
```

Select the skills to install, then start a fresh Claude Code session in your target project and ask it to use the relevant skill. Add `-g` for a global installation.

### Other Skills-Compatible Agents

Use the universal Skills CLI command to select another agent. Installation locations and discovery controls vary by host. Verify the skills in your target agent.

## Usage

Open your project in your coding assistant and describe what you want to review or build. Skills can load automatically when relevant. Name `redis-code` or `azure-redis-infra` to make your intent explicit. Review generated changes and test before production use.

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

### Migration to Azure Managed Redis

Migration guidance is maintained in separate skills, not bundled with this kit:

| Source service/tier | Migration skill and installation instructions |
|---|---|
| Azure Cache for Redis Basic, Standard, or Premium (ACR/OSS) | [amr-migration-skill](https://github.com/AzureManagedRedis/amr-migration-skill#usage) |
| Azure Cache for Redis Enterprise or Enterprise Flash (ACRE) | [acre-to-amr-migration-skill](https://github.com/AzureManagedRedis/acre-to-amr-migration-skill#usage) |

For migration help, use the skill matching your source service/tier. If the source is unclear, the agent should ask before choosing a skill.

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

## Support and Feedback

| Issue | Where to report it |
|---|---|
| Kit installation, loading or execution failures, incorrect output, missing guidance, or feature requests | Open an issue in [this repository](https://github.com/AzureManagedRedis/amr-agent-kit/issues). |
| Problems with the underlying Redis service or Azure infrastructure | Use [normal Azure support channels](https://learn.microsoft.com/azure/azure-portal/supportability/how-to-create-azure-support-request). Microsoft Customer Service and Support (CSS) supports these underlying scenarios. |

For kit issues, include:

- The coding assistant and version, operating system, and installation method.
- The kit version or source commit, if known.
- Reproduction steps and the prompt, expected behavior, and actual behavior.
- Relevant error messages or skill-loading evidence.

Use a minimal, sanitized example. Don't include credentials, customer data, confidential code, or sensitive logs in public issues.

## External Resources

These skills reference Azure Managed Redis and Redis documentation, including:

- [Azure Managed Redis overview](https://learn.microsoft.com/en-us/azure/redis/overview)
- [Azure Managed Redis architecture](https://learn.microsoft.com/en-us/azure/redis/architecture)
- [Azure Managed Redis Private Link](https://learn.microsoft.com/en-us/azure/redis/private-link)
- [Microsoft Entra authentication for Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication)
- [Redis developer documentation](https://redis.io/docs/latest/develop/)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for repository structure, rule authoring, build, and validation instructions. These steps aren't required to install or use the kit.

Evaluation resources cover [routing](routing-eval/README.md), content tasks for [application code](evals/redis-code/) and [infrastructure](evals/azure-redis-infra/), and [answer efficacy](evals/efficacy/README.md). Mock runs do not establish real-model answer quality or validate deployments.

The static website source is under [docs/](docs/).

## Compatibility

Skills CLI supports installation into multiple coding agents. Verify skill loading and behavior in your target host; installer support does not establish tested kit compatibility.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a dated history of updates to the agent kit.

## License

MIT
