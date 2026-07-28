---
name: azure-redis-infra
description: |
  Azure Managed Redis (Redis Enterprise 7.4) infrastructure patterns and best
  practices. Use when provisioning AMR, configuring networking/security,
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

Patterns and best practices for provisioning, securing, and operating Azure Managed Redis (Redis Enterprise 7.4) in Azure.

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

When generating infrastructure as code, model Azure Managed Redis directly rather than as generic Redis. For ARM and Bicep, use a `Microsoft.Cache/redisEnterprise` cluster plus a `Microsoft.Cache/redisEnterprise/databases` child named `default`. For Terraform, use `azurerm_managed_redis` with a `default_database` block. Keep the data-plane choices such as port `10000`, `clientProtocol`, `clusteringPolicy`, `evictionPolicy`, persistence, and modules on the database/default database configuration.

### Prefer Secure Azure Defaults

For production guidance, prefer Private Link, disabled public network access, TLS 1.2 or later, Microsoft Entra authentication, Azure RBAC, diagnostic logging, and Azure Monitor metrics.

### Design Tenant Boundaries Explicitly

Azure Managed Redis does not support Redis logical-database multi-tenancy with `SELECT` or numbered DB indexes. For tenant-aware deployments, use scoped identities, data access policies/key patterns, application key prefixes, metadata filters for search/RAG workloads, and separate AMR caches when tenants need hard isolation or independent lifecycle.

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

- [AGENTS.md](AGENTS.md) - Compact generated rule catalog.
- `rules/` - Detailed source rules loaded individually as needed.
- `rules/_sections.md` - Category ordering, impact, and descriptions.
- `metadata.json` - Version, abstract, and reference links.

Use progressive disclosure: choose the matching category below, read only the linked rules needed for the task, and follow their official documentation links for current product limits. Do not load the entire rule set by default.

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
- [Choose tiers/SKUs based on workload needs](rules/provision-select-tier.md)
- [Enable required modules at creation time](rules/provision-select-modules-at-create.md)
- [Capture AMR creation-time settings in IaC](rules/provision-codify-creation-time-settings.md)
- [Generate native ARM, Bicep, and Terraform shapes](rules/provision-use-native-amr-iac.md)

### 2. Networking & Access (CRITICAL)

Private endpoints, public network access, and DNS integration.
- [Use Private Link and control public network access](rules/network-use-private-link.md)
- [Configure private DNS for all client networks](rules/network-configure-private-dns.md)

### 3. Security & Identity (CRITICAL)

TLS 1.2/1.3, Entra ID authentication, and key management.
- [Enforce TLS for client connections](rules/security-enforce-tls.md)
- [Prefer Entra authentication over access keys](rules/security-use-entra-authentication.md)
- [Scope data access by identity and key pattern](rules/security-scope-data-access-policies.md)
- [Rotate keys and keep secrets out of code](rules/security-rotate-keys-and-protect-secrets.md)

### 4. Availability & Zone Redundancy (HIGH)

High availability configuration and zone-redundant deployment.
- [Plan HA and zone redundancy](rules/availability-enable-ha-zone-redundancy.md)

### 5. Geo-Replication & DR (HIGH)

Active geo-replication, consistency, and failover planning.
- [Plan active geo-replication for multi-region DR](rules/geo-plan-active-geo-replication.md)

### 6. Data Durability & Backup (MEDIUM-HIGH)

RDB/AOF persistence and export-based backups.
- [Use persistence for recovery and export for backups](rules/durability-configure-persistence.md)

### 7. Performance & Cluster Policy (MEDIUM)

OSS vs Enterprise cluster policy selection and throughput planning.
- [Match cluster policy to clients and modules](rules/performance-choose-cluster-policy.md)

### 8. Observability & Diagnostics (MEDIUM)

Azure Monitor metrics, diagnostics, and connection logs.
- [Enable Azure Monitor metrics and connection logs](rules/observability-enable-diagnostics.md)
- [Set alert baselines before launch](rules/observability-set-alert-baselines.md)

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
- Use [AGENTS.md](AGENTS.md) only as a catalog when the matching rule is not obvious; load the selected rule file for complete guidance and references.
