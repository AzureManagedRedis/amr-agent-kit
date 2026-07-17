# Azure Managed Redis Infrastructure Skill

An [Open Agent Skill](https://agentskills.io/) for provisioning, securing, and operating Azure Managed Redis in Azure.

## Overview

This skill helps AI agents guide Azure Managed Redis infrastructure decisions. It contains 15 rules across 8 categories covering provisioning and sizing, networking, security, availability, geo-replication, data durability, performance and cluster policy, and observability.

Use this skill for:

- Azure Managed Redis tier, SKU, region, and capacity planning
- Private Link, public network access, DNS, and connectivity design
- TLS, Microsoft Entra authentication, access keys, and RBAC decisions
- High availability, zone redundancy, active geo-replication, and failover planning
- RDB/AOF persistence, export backups, and durability trade-offs
- Azure Monitor metrics, diagnostics, connection logs, and alerting

## Scope

- Azure Managed Redis (AMR)
- Redis Enterprise 7.4 capabilities on Azure
- Azure-native controls for networking, identity, reliability, durability, performance, and observability

## Usage

Load this skill into an AI agent that supports Open Agent Skills. The agent should activate it when a user asks about Azure Managed Redis provisioning, networking, security, high availability, geo-replication, persistence, cluster policy, or monitoring.

### With GitHub Copilot CLI

Install the full AMR Agent Kit, then reload skills:

```bash
npx skills add AzureManagedRedis/amr-agent-kit -g -a github-copilot
```

```text
/skills reload
/skills info azure-redis-infra
```

### Manual Copy

Copy this folder into the target agent's skills directory:

```text
skills/azure-redis-infra/
```

## Example Prompts

### Provisioning and Sizing

- **"Help me choose an Azure Managed Redis tier and SKU for this workload."**
- **"Review this AMR provisioning plan for modules and cluster policy."**
- **"What AMR settings should I decide before creation?"**

### Networking and Security

- **"Set up Azure Managed Redis with Private Link and disabled public access."**
- **"Review my AMR TLS and Entra authentication configuration."**
- **"What DNS and port requirements should clients expect for AMR?"**

### Reliability and Operations

- **"Plan high availability, zone redundancy, and failover for AMR."**
- **"Design active geo-replication for multi-region DR."**
- **"Enable Azure Monitor diagnostics and alerts for AMR."**

## Skill Structure

```text
azure-redis-infra/
+-- SKILL.md
+-- README.md
+-- metadata.json
+-- AGENTS.md
+-- rules/
    +-- _sections.md
    +-- _template.md
    +-- provision-*.md
    +-- network-*.md
    +-- security-*.md
    +-- availability-*.md
    +-- geo-*.md
    +-- durability-*.md
    +-- performance-*.md
    +-- observability-*.md
```

## Rule Categories

| Priority | Category | Impact | Prefix |
|----------|----------|--------|--------|
| 1 | Provisioning & Sizing | CRITICAL | `provision-` |
| 2 | Networking & Access | CRITICAL | `network-` |
| 3 | Security & Identity | CRITICAL | `security-` |
| 4 | Availability & Zone Redundancy | HIGH | `availability-` |
| 5 | Geo-Replication & DR | HIGH | `geo-` |
| 6 | Data Durability & Backup | MEDIUM-HIGH | `durability-` |
| 7 | Performance & Cluster Policy | MEDIUM | `performance-` |
| 8 | Observability & Diagnostics | MEDIUM | `observability-` |

## Creating a New Rule

1. Copy `rules/_template.md` to `rules/{prefix}-{description}.md`.
2. Choose the prefix that matches the category in the table above.
3. Fill in frontmatter and content.
4. Include Azure-specific implementation notes and examples.
5. Run the build to regenerate `AGENTS.md`.

## Building and Validation

From the repository root:

```bash
cd packages/amr-agent-skills-build
npm install
npm run build-azure-redis-infra
npm run validate
```

## External Resources

This skill references Azure Managed Redis documentation, including:

- [Azure Managed Redis overview](https://learn.microsoft.com/en-us/azure/redis/overview)
- [Azure Managed Redis architecture](https://learn.microsoft.com/en-us/azure/redis/architecture)
- [Reliability in Azure Managed Redis](https://learn.microsoft.com/en-us/azure/reliability/reliability-managed-redis)
- [Azure Managed Redis Private Link](https://learn.microsoft.com/en-us/azure/redis/private-link)
- [TLS configuration](https://learn.microsoft.com/en-us/azure/redis/tls-configuration)
- [Microsoft Entra authentication for Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication)
- [Active geo-replication](https://learn.microsoft.com/en-us/azure/redis/how-to-active-geo-replication)
- [Azure Monitor diagnostic settings](https://learn.microsoft.com/en-us/azure/redis/monitor-diagnostic-settings)

## Contributing

1. Keep rules focused on Azure Managed Redis infrastructure and operations.
2. Use existing category prefixes and naming conventions.
3. Update examples when Azure Managed Redis platform guidance changes.
4. Rebuild generated guidance before opening a pull request.

## License

MIT
