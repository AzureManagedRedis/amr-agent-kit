# Azure Managed Redis Infrastructure Rule Index

**Version 1.0.0**  
Microsoft  
February 2026

Patterns and best practices for provisioning, securing, and operating Azure Managed Redis in Azure. Covers metric-based provisioning and sizing, native ARM/Bicep/Terraform generation, module selection, networking, security, availability, geo-replication, data durability, performance tuning, and observability.

This generated file is a compact catalog, not a complete instruction bundle. Start with [SKILL.md](SKILL.md), select only the categories relevant to the task, and then read the linked source rules under `rules/`. Do not load every rule unless the task genuinely spans the full skill.

## 1. Provisioning & Sizing

**Category impact: CRITICAL**

- **1.1** [Codify Creation-Time Settings in Infrastructure as Code](rules/provision-codify-creation-time-settings.md) — CRITICAL
- **1.2** [Generate Native AMR Infrastructure as Code](rules/provision-use-native-amr-iac.md) — CRITICAL
- **1.3** [Select Redis Modules at Provisioning Time](rules/provision-select-modules-at-create.md) — CRITICAL
- **1.4** [Select the Right Tier and SKU Before Provisioning](rules/provision-select-tier.md) — CRITICAL

## 2. Networking & Access

**Category impact: CRITICAL**

- **2.1** [Configure Private DNS for Private Endpoints](rules/network-configure-private-dns.md) — CRITICAL
- **2.2** [Use Private Link and Disable Public Network Access](rules/network-use-private-link.md) — CRITICAL

## 3. Security & Identity

**Category impact: CRITICAL**

- **3.1** [Enforce TLS 1.2+ for All Client Connections](rules/security-enforce-tls.md) — CRITICAL
- **3.2** [Prefer Microsoft Entra Authentication Over Access Keys](rules/security-use-entra-authentication.md) — CRITICAL
- **3.3** [Rotate Access Keys and Keep Secrets Out of Code](rules/security-rotate-keys-and-protect-secrets.md) — CRITICAL
- **3.4** [Scope Data Access Policies to Identities and Key Patterns](rules/security-scope-data-access-policies.md) — CRITICAL

## 4. Availability & Zone Redundancy

**Category impact: HIGH**

- **4.1** [Enable High Availability and Zone Redundancy](rules/availability-enable-ha-zone-redundancy.md) — HIGH

## 5. Geo-Replication & DR

**Category impact: HIGH**

- **5.1** [Plan Active Geo-Replication for Multi-Region DR](rules/geo-plan-active-geo-replication.md) — HIGH

## 6. Data Durability & Backup

**Category impact: MEDIUM-HIGH**

- **6.1** [Configure Persistence for Node Recovery, Use Export for Backups](rules/durability-configure-persistence.md) — MEDIUM-HIGH

## 7. Performance & Cluster Policy

**Category impact: MEDIUM**

- **7.1** [Choose Cluster Policy Based on Client and Module Needs](rules/performance-choose-cluster-policy.md) — MEDIUM

## 8. Observability & Diagnostics

**Category impact: MEDIUM**

- **8.1** [Enable Azure Monitor Metrics and Connection Logs](rules/observability-enable-diagnostics.md) — MEDIUM
- **8.2** [Set Azure Monitor Alert Baselines Before Launch](rules/observability-set-alert-baselines.md) — HIGH

## Product References

1. [https://learn.microsoft.com/en-us/azure/redis/overview](https://learn.microsoft.com/en-us/azure/redis/overview)
2. [https://learn.microsoft.com/en-us/azure/redis/architecture](https://learn.microsoft.com/en-us/azure/redis/architecture)
3. [https://learn.microsoft.com/en-us/azure/reliability/reliability-managed-redis](https://learn.microsoft.com/en-us/azure/reliability/reliability-managed-redis)
4. [https://learn.microsoft.com/en-us/azure/redis/private-link](https://learn.microsoft.com/en-us/azure/redis/private-link)
5. [https://learn.microsoft.com/en-us/azure/redis/tls-configuration](https://learn.microsoft.com/en-us/azure/redis/tls-configuration)
6. [https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication](https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication)
7. [https://learn.microsoft.com/en-us/azure/redis/how-to-active-geo-replication](https://learn.microsoft.com/en-us/azure/redis/how-to-active-geo-replication)
8. [https://learn.microsoft.com/en-us/azure/redis/how-to-persistence](https://learn.microsoft.com/en-us/azure/redis/how-to-persistence)
9. [https://learn.microsoft.com/en-us/azure/redis/monitor-diagnostic-settings](https://learn.microsoft.com/en-us/azure/redis/monitor-diagnostic-settings)
10. [https://learn.microsoft.com/en-us/azure/redis/how-to-import-export-data](https://learn.microsoft.com/en-us/azure/redis/how-to-import-export-data)
11. [https://learn.microsoft.com/en-us/azure/templates/microsoft.cache/redisenterprise](https://learn.microsoft.com/en-us/azure/templates/microsoft.cache/redisenterprise)
12. [https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/managed_redis](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/managed_redis)
