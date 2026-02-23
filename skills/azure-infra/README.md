# Azure Managed Redis Infrastructure

Patterns and best practices for provisioning and operating Azure Managed Redis (Redis Enterprise 7.4) in Azure, optimized for agents and LLMs.

## Structure

- `rules/` - Individual rule files (one per rule)
  - `_sections.md` - Section metadata (titles, impacts, descriptions)
  - `_template.md` - Template for creating new rules
  - `{prefix}-{description}.md` - Individual rule files
- `metadata.json` - Document metadata
- `SKILL.md` - Agent-facing skill definition
- **`AGENTS.md`** - Compiled output (generated)

## Scope

- **Azure Managed Redis (AMR)** only
- **Redis Enterprise 7.4** capabilities and Azure-native controls
- **Azure infrastructure** best practices (Private Link, Entra ID, Azure Monitor, HA/zone redundancy, active geo-replication)

## Creating a New Rule

1. Copy `rules/_template.md` to `rules/{prefix}-{description}.md`
2. Choose appropriate prefix based on category:
   - `provision-` Provisioning & Sizing
   - `network-` Networking & Access
   - `security-` Security & Identity
   - `availability-` Availability & Zone Redundancy
   - `geo-` Geo-Replication & DR
   - `durability-` Data Durability & Backup
   - `performance-` Performance & Cluster Policy
   - `observability-` Observability & Diagnostics
3. Fill in frontmatter and content
4. Run build to regenerate AGENTS.md

## Building

From the build package directory:

```bash
cd packages/amr-agent-skills-build
npm install
npm run build
```

## Validation

```bash
npm run validate
```
