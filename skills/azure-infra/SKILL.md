---
name: azure-infra
description: Azure Managed Redis (Redis Enterprise 7.4) infrastructure patterns and best practices. Use when provisioning AMR, configuring networking/security, enabling HA or geo-replication, setting persistence, or monitoring AMR in Azure. Triggers on tasks involving Azure Managed Redis, private endpoints, Entra ID auth, TLS, active geo-replication, zone redundancy, or Azure Monitor diagnostics.
license: MIT
metadata:
  author: redis
  version: "1.0.0"
---

# Azure Managed Redis Infrastructure

Patterns and best practices for provisioning, securing, and operating Azure Managed Redis (Redis Enterprise 7.4) in Azure.

## When to Apply

Reference these guidelines when:
- Provisioning Azure Managed Redis and selecting the right tier/SKU
- Configuring networking (Private Link, public network access, DNS)
- Enforcing security (TLS, Entra ID, access keys, RBAC)
- Enabling high availability, zone redundancy, and failover
- Planning active geo-replication and DR
- Configuring data persistence and export backups
- Choosing cluster policies for client compatibility
- Monitoring with Azure Monitor diagnostics and metrics

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

### 2. Networking & Access (CRITICAL)

Private endpoints, public network access, and DNS integration.

### 3. Security & Identity (CRITICAL)

TLS 1.2/1.3, Entra ID authentication, and key management.

### 4. Availability & Zone Redundancy (HIGH)

High availability configuration and zone-redundant deployment.

### 5. Geo-Replication & DR (HIGH)

Active geo-replication, consistency, and failover planning.

### 6. Data Durability & Backup (MEDIUM-HIGH)

RDB/AOF persistence and export-based backups.

### 7. Performance & Cluster Policy (MEDIUM)

OSS vs Enterprise cluster policy selection and throughput planning.

### 8. Observability & Diagnostics (MEDIUM)

Azure Monitor metrics, diagnostics, and connection logs.

## How to Use

Read individual rule files for detailed explanations and examples:

```
rules/provision-select-tier.md
rules/network-private-link.md
rules/security-entra-authentication.md
```

Each rule file contains:
- Brief explanation of why it matters
- Configuration examples or commands
- Azure-specific implementation notes
- Additional context and references

## Full Compiled Document

For the complete guide with all rules expanded: `AGENTS.md`
