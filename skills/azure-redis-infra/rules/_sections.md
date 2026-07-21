# Sections

This file defines all sections, their ordering, impact levels, and descriptions.
The section ID (in parentheses) is the filename prefix used to group rules.

---

## 1. Provisioning & Sizing (provision)

**Impact:** CRITICAL

**Description:** Choose the right Azure Managed Redis tier/SKU, region, capacity, and native IaC shape to meet latency, throughput, and cost goals. Covers memory/compute/flash tiers, region placement, sizing from workload metrics, and ARM/Bicep/Terraform generation.

---

## 2. Networking & Access (network)

**Impact:** CRITICAL

**Description:** Secure connectivity with Private Link, disable public network access, and configure DNS/port requirements for AMR cluster policies.

---

## 3. Security & Identity (security)

**Impact:** CRITICAL

**Description:** Enforce the supported minimum TLS version of 1.2, prefer Microsoft Entra authentication, and control access keys and RBAC for Azure Managed Redis.

---

## 4. Availability & Zone Redundancy (availability)

**Impact:** HIGH

**Description:** Enable high availability and zone redundancy to survive node and zone failures in Azure regions with availability zones.

---

## 5. Geo-Replication & DR (geo)

**Impact:** HIGH

**Description:** Plan active geo-replication groups, eventual consistency behavior, and DR workflows for multi-region continuity.

---

## 6. Data Durability & Backup (durability)

**Impact:** MEDIUM-HIGH

**Description:** Configure RDB/AOF persistence for node recovery and use export for backups and migration. Covers limitations and feature incompatibilities.

---

## 7. Performance & Cluster Policy (performance)

**Impact:** MEDIUM

**Description:** Choose OSS vs Enterprise cluster policy, understand port requirements, and align client capabilities with throughput goals.

---

## 8. Observability & Diagnostics (observability)

**Impact:** MEDIUM

**Description:** Configure Azure Monitor metrics and diagnostic logs, enable connection auditing, and set alerting for AMR performance and security.
