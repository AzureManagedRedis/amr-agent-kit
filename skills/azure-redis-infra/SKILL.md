---
name: azure-redis-infra
description: |
  Azure Managed Redis infrastructure patterns and best practices. Use when
  provisioning AMR, configuring networking/security,
  enabling high availability or geo-replication, setting persistence, choosing
  cluster policy, generating native ARM/Bicep/Terraform, sizing from workload
  metrics, or monitoring AMR in Azure. Triggers on tasks involving Azure
  Managed Redis, private endpoints, Entra ID auth, TLS, active geo-replication,
  zone redundancy, Azure Monitor diagnostics, persistence, or AMR SKU selection.
  Do NOT use for: Redis application code patterns, vector/RAG application design,
  semantic caching, LLM memory, or Azure infrastructure unrelated to Azure Managed
  Redis.
license: MIT
metadata:
  author: Microsoft
  version: "1.0.0"
---

# Azure Managed Redis Infrastructure

Patterns and best practices for provisioning, securing, and operating Azure Managed Redis in Azure.

## Scope

- Provisioning Azure Managed Redis and selecting the right tier/SKU
- Generating native ARM, Bicep, or Terraform for Azure Managed Redis
- Configuring networking (Private Link, public network access, DNS)
- Enforcing security (TLS, Entra ID, access keys, RBAC)
- Enabling high availability, zone redundancy, and failover
- Planning active geo-replication and DR
- Configuring data persistence and export backups
- Choosing cluster policies for client compatibility
- Monitoring with Azure Monitor diagnostics and metrics

## Agent Guidance

### Validate Creation-Time Choices Early

For Azure Managed Redis, several choices should be decided before provisioning, including tier/SKU, modules, cluster policy, high availability, active geo-replication, protocol mode, persistence, and networking model. Surface these early to avoid disruptive reprovisioning.

### Size from Metrics, Not Source Labels

When reviewing or generating AMR sizing guidance, explicitly compare Memory Optimized (M-series), Balanced (B-series), Compute Optimized (X-series), and Flash Optimized tiers. Use peak and P95 used memory, Server Load or CPU pressure, connected clients, read/write bandwidth, latency targets, module needs, region availability, preview status, HA, networking, diagnostics, and active geo needs. Avoid customer-facing shard-count recommendations; describe scale with tier, SKU, capacity, usable memory, and cluster policy.

### Prefer Native AMR IaC Shapes

When generating infrastructure as code, model Azure Managed Redis directly rather than as generic Redis. For ARM and Bicep, use a `Microsoft.Cache/redisEnterprise` cluster plus a `Microsoft.Cache/redisEnterprise/databases` child named `default`. For Terraform, use `azurerm_managed_redis` with a `default_database` block. Keep data-plane choices such as the configured database port (`10000` by default), `clientProtocol`, `clusteringPolicy`, `evictionPolicy`, persistence, and modules on the database/default database configuration.

### Prefer Secure Azure Defaults

For production guidance, prefer Private Link, disabled public network access, TLS 1.2 or later, Microsoft Entra authentication, Azure RBAC, diagnostic logging, and Azure Monitor metrics.

### Design Tenant Boundaries Explicitly

Do not assume Azure Managed Redis preserves Azure Cache for Redis-style numbered-database multi-tenancy. Under clustered policies (OSSCluster, EnterpriseCluster) and under active geo-replication, only database 0 is available and `SELECT` to another index is not supported. Under `NoCluster`, do not assert either DB0-only or multiple logical databases without evidence; a single managed `default` database resource does not prove the logical database count, so confirm it from the database's effective configuration or a live `SELECT` capability check before relying on more than database 0. Regardless of cluster policy, prefer application key prefixes as the portable logical-separation approach and separate AMR caches for hard tenant isolation or independent lifecycle. Also use scoped identities, data access policies/key patterns, and metadata filters for search/RAG workloads.

### Separate Infrastructure Workflows

Choose the correct guidance path based on the user's intent:

| User Intent | Signal Phrases | Primary Categories |
|---|---|---|
| Create or size AMR | "provision", "SKU", "tier", "modules", "capacity" | Provisioning & Sizing |
| Secure connectivity | "private endpoint", "Private Link", "DNS", "public access" | Networking & Access, Security & Identity |
| Configure identity and transport | "TLS", "Entra", "RBAC", "access keys" | Security & Identity |
| Plan reliability | "HA", "zone redundancy", "failover", "DR", "geo" | Availability & Zone Redundancy, Geo-Replication & DR |
| Protect and operate data | "persistence", "backup", "export", "monitor", "diagnostics" | Data Durability & Backup, Observability & Diagnostics |

## Available Resources

- `AGENTS.md` - Full compiled guidance with expanded rules, examples, and references.
- `rules/` - Individual rule files for targeted guidance.
- `rules/_sections.md` - Category ordering, impact, and descriptions.
- `metadata.json` - Version, abstract, and reference links.

## Azure Managed Redis Infrastructure Workflow

1. Identify workload goals: latency, throughput, memory, modules, compliance, availability, and recovery requirements.
2. Select tier, SKU, region, modules, and cluster policy before provisioning.
3. Design networking with Private Link, DNS, and public network access decisions.
4. Enforce TLS and prefer Microsoft Entra authentication with Azure RBAC.
5. Plan high availability, zone redundancy, active geo-replication, and persistence.
6. Enable Azure Monitor metrics, diagnostic logs, connection auditing, and alerting.

## Rule Categories by Priority

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

## Quick Reference

### 1. Provisioning & Sizing (CRITICAL)

Tier/SKU selection, region placement, and capacity planning.
- `provision-select-tier` - Choose tiers/SKUs based on workload needs
- `provision-select-modules-at-create` - Enable required modules at creation time
- `provision-codify-creation-time-settings` - Capture AMR creation-time settings in IaC
- `provision-use-native-amr-iac` - Generate native ARM, Bicep, and Terraform shapes for AMR

### 2. Networking & Access (CRITICAL)

Private endpoints, public network access, and DNS integration.
- `network-use-private-link` - Use Private Link and disable public network access
- `network-configure-private-dns` - Link private DNS for all client networks

### 3. Security & Identity (CRITICAL)

Minimum TLS version 1.2, Entra ID authentication, and key management.
- `security-enforce-tls` - Enforce TLS for all client connections
- `security-use-entra-authentication` - Prefer Entra authentication over access keys
- `security-scope-data-access-policies` - Scope data access by identity and key pattern
- `security-rotate-keys-and-protect-secrets` - Rotate keys and keep secrets out of code

### 4. Availability & Zone Redundancy (HIGH)

High availability configuration and zone-redundant deployment.
- `availability-enable-ha-zone-redundancy` - Enable HA and zone redundancy where supported

### 5. Geo-Replication & DR (HIGH)

Active geo-replication, consistency, and failover planning.
- `geo-plan-active-geo-replication` - Plan active geo-replication for multi-region DR

### 6. Data Durability & Backup (MEDIUM-HIGH)

RDB/AOF persistence and export-based backups.
- `durability-configure-persistence` - Use persistence for recovery and export for backups

### 7. Performance & Cluster Policy (MEDIUM)

OSS vs Enterprise cluster policy selection and throughput planning.
- `performance-choose-cluster-policy` - Match cluster policy to clients and modules

### 8. Observability & Diagnostics (MEDIUM)

Azure Monitor metrics, diagnostics, and connection logs.
- `observability-enable-diagnostics` - Enable Azure Monitor metrics and connection logs
- `observability-set-alert-baselines` - Set alert baselines before launch

## How to Use the Rule Files

Read individual rule files for detailed explanations and examples:

```
rules/provision-select-tier.md
rules/network-use-private-link.md
rules/security-use-entra-authentication.md
```

Each rule file contains:
- Brief explanation of why it matters
- Configuration examples or commands
- Azure-specific implementation notes
- Additional context and references

## Tips for Effective Infrastructure Guidance

- Ask for workload goals before recommending an AMR SKU or topology.
- Call out creation-time settings that cannot be changed later.
- Prefer private, TLS-protected, identity-based access for production workloads.
- Tie reliability guidance to region, availability zone, and DR requirements.
- Use `AGENTS.md` when the user needs full expanded examples or references.

## Full Compiled Document

For the complete guide with all rules expanded, use `AGENTS.md`.
