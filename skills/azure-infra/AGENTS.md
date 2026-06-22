# Azure Managed Redis Infrastructure

**Version 1.0.0**  
Microsoft  
February 2026

> **Note:**  
> This document is mainly for agents and LLMs to follow when maintaining,  
> generating, or refactoring Azure Managed Redis infrastructure and operations. Humans  
> may also find it useful, but guidance here is optimized for automation  
> and consistency by AI-assisted workflows.

---

## Abstract

Patterns and best practices for provisioning, securing, and operating Azure Managed Redis (Redis Enterprise 7.4) in Azure. Covers provisioning and sizing, module selection, networking, security, availability, geo-replication, data durability, performance tuning, and observability.

---

## Table of Contents

1. [Provisioning & Sizing](#1-provisioning--sizing) — **CRITICAL**
   - 1.1 [Codify Creation-Time Settings in Infrastructure as Code](#11-codify-creation-time-settings-in-infrastructure-as-code)
   - 1.2 [Select Redis Modules at Provisioning Time](#12-select-redis-modules-at-provisioning-time)
   - 1.3 [Select the Right Tier and SKU Before Provisioning](#13-select-the-right-tier-and-sku-before-provisioning)
2. [Networking & Access](#2-networking--access) — **CRITICAL**
   - 2.1 [Configure Private DNS for Private Endpoints](#21-configure-private-dns-for-private-endpoints)
   - 2.2 [Use Private Link and Disable Public Network Access](#22-use-private-link-and-disable-public-network-access)
3. [Security & Identity](#3-security--identity) — **CRITICAL**
   - 3.1 [Enforce TLS 1.2+ for All Client Connections](#31-enforce-tls-12-for-all-client-connections)
   - 3.2 [Prefer Microsoft Entra Authentication Over Access Keys](#32-prefer-microsoft-entra-authentication-over-access-keys)
   - 3.3 [Rotate Access Keys and Keep Secrets Out of Code](#33-rotate-access-keys-and-keep-secrets-out-of-code)
   - 3.4 [Scope Data Access Policies to Identities and Key Patterns](#34-scope-data-access-policies-to-identities-and-key-patterns)
4. [Availability & Zone Redundancy](#4-availability--zone-redundancy) — **HIGH**
   - 4.1 [Enable High Availability and Zone Redundancy](#41-enable-high-availability-and-zone-redundancy)
5. [Geo-Replication & DR](#5-geo-replication--dr) — **HIGH**
   - 5.1 [Plan Active Geo-Replication for Multi-Region DR](#51-plan-active-geo-replication-for-multi-region-dr)
6. [Data Durability & Backup](#6-data-durability--backup) — **MEDIUM-HIGH**
   - 6.1 [Configure Persistence for Node Recovery, Use Export for Backups](#61-configure-persistence-for-node-recovery-use-export-for-backups)
7. [Performance & Cluster Policy](#7-performance--cluster-policy) — **MEDIUM**
   - 7.1 [Choose Cluster Policy Based on Client and Module Needs](#71-choose-cluster-policy-based-on-client-and-module-needs)
8. [Observability & Diagnostics](#8-observability--diagnostics) — **MEDIUM**
   - 8.1 [Enable Azure Monitor Metrics and Connection Logs](#81-enable-azure-monitor-metrics-and-connection-logs)
   - 8.2 [Set Azure Monitor Alert Baselines Before Launch](#82-set-azure-monitor-alert-baselines-before-launch)

---

## 1. Provisioning & Sizing

**Impact: CRITICAL**

Choose the right Azure Managed Redis tier/SKU, region, and capacity to meet latency, throughput, and cost goals. Covers memory/compute/flash tiers, region placement, and sizing for Redis Enterprise 7.4.

---

### 1.1 Codify Creation-Time Settings in Infrastructure as Code

**Impact: CRITICAL (prevents drift and disruptive reprovisioning)**

Azure Managed Redis choices such as tier/SKU, region, modules, cluster policy, high availability, active geo-replication, private connectivity, diagnostics, and access policies should be modeled before deployment. Use Bicep, Azure Verified Modules, or Terraform modules with parameters per environment, and review changes with `what-if`, `terraform validate`, and `terraform plan` before applying. Portal-only deployments hide creation-time decisions and increase drift.

**Incorrect: manual deployment with deferred decisions**

```text
Provisioning: portal click-through
Tier/SKU: smallest available
Modules: decide after go-live
Cluster policy: decide after clients are built
Networking/Security/Diagnostics: manual follow-up tasks
Preflight: no what-if or plan review
```

**Correct: repeatable IaC baseline**

```text
IaC: Bicep/AVM or Terraform module checked into source control
Parameters: tier, SKU, region, modules, cluster policy, HA, zones
Networking: private endpoint, publicNetworkAccess, DNS links
Security: Entra users, access policies, TLS, key posture
Preflight: az deployment what-if or terraform validate && terraform plan
Operations: diagnostic settings and alerts deployed with the cache
```

Reference: [https://learn.microsoft.com/en-us/azure/templates/microsoft.cache/redisenterprise](https://learn.microsoft.com/en-us/azure/templates/microsoft.cache/redisenterprise), [https://learn.microsoft.com/en-us/azure/redis/quickstart-create-managed-redis](https://learn.microsoft.com/en-us/azure/redis/quickstart-create-managed-redis)

### 1.2 Select Redis Modules at Provisioning Time

**Impact: CRITICAL (avoids reprovisioning when modules are required)**

Azure Managed Redis requires modules (RediSearch, RedisJSON, etc.) to be enabled during cache creation. You can't add modules after the instance is created, so plan module requirements early to avoid rebuilding or migrating the cache later.

**Incorrect: enable modules after creation**

```text
Create cache: Modules = none
Later requirement: Enable RediSearch
Result: must rebuild a new cache
```

**Correct: enable required modules at creation**

```text
Create cache: Modules = RediSearch, RedisJSON
Cluster policy: Enterprise
Result: vector search and JSON features available
```

Reference: [https://learn.microsoft.com/en-us/azure/redis/quickstart-create-managed-redis](https://learn.microsoft.com/en-us/azure/redis/quickstart-create-managed-redis)

### 1.3 Select the Right Tier and SKU Before Provisioning

**Impact: CRITICAL (avoids under-provisioning and rework)**

Azure Managed Redis tiers (Memory Optimized, Balanced, Compute Optimized, Flash Optimized) have different memory-to-vCPU ratios and performance profiles. Choose the tier, size, and region that match latency targets and dataset size, and enable features like active geo-replication at creation time because they cannot be added later. Under-sizing or picking the wrong tier forces disruptive reprovisioning.

**Incorrect: pick the smallest tier and plan to change later**

```text
# Smallest tier chosen for a latency-sensitive workload
Tier: Balanced B10
Performance: Low
ActiveGeoReplication: Disabled  # plan to enable after go-live (not supported)
Region: East US
```

**Correct: size for workload and enable required features up front**

```text
# Match tier to workload and enable geo-replication at creation time
Tier: Compute Optimized X20
Performance: High throughput
ActiveGeoReplication: Enabled
Region: same as application region
```

Reference: [https://learn.microsoft.com/en-us/azure/redis/quickstart-create-managed-redis](https://learn.microsoft.com/en-us/azure/redis/quickstart-create-managed-redis), [https://learn.microsoft.com/en-us/azure/redis/overview](https://learn.microsoft.com/en-us/azure/redis/overview)

---

## 2. Networking & Access

**Impact: CRITICAL**

Secure connectivity with Private Link, disable public network access, and configure DNS/port requirements for AMR cluster policies.

---

### 2.1 Configure Private DNS for Private Endpoints

**Impact: CRITICAL (avoids private endpoint connectivity and TLS failures)**

Private Link is only reliable when every client network resolves the Azure Managed Redis host name to the private endpoint IP. Keep applications configured to connect to `<cache-name>.<region>.redis.azure.net` on port `10000`, link the Private DNS zone to every spoke, AKS, management, and shared-services VNet that needs access, and add DNS forwarding for on-premises or custom DNS resolvers. Do not configure clients to use the `privatelink` host name directly.

**Incorrect: private endpoint without end-to-end DNS**

```text
Private endpoint: Created
Application host: <cache-name>.privatelink.redis.azure.net
Linked VNets: only the endpoint VNet
On-prem/custom DNS: no conditional forwarding
Validation: no nslookup from workload subnets
```

**Correct: private DNS integrated with every client network**

```text
Application host: <cache-name>.<region>.redis.azure.net
Port: 10000
Private DNS zone: *.privatelink.redis.azure.net
VNet links: AKS spoke, app spoke, management VNet, shared resolver VNet
Custom DNS: conditional forwarding to Azure DNS/private resolver
Validation: nslookup from each client subnet returns the private endpoint IP
```

Reference: [https://learn.microsoft.com/en-us/azure/redis/private-link](https://learn.microsoft.com/en-us/azure/redis/private-link), [https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-dns](https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-dns)

### 2.2 Use Private Link and Disable Public Network Access

**Impact: CRITICAL (reduces exposure to the public internet)**

Azure Managed Redis recommends Private Link for secure network isolation. For production, create a private endpoint and disable public network access so traffic stays inside the VNet. Configure DNS so clients resolve the cache hostname to the private IP.

**Incorrect: public endpoint exposed**

```text
Networking: Public access enabled
Private Endpoint: Not configured
DNS: Public hostname resolution
```

**Correct: private endpoint and public access disabled**

```text
Networking: Private Endpoint
PublicNetworkAccess: Disabled
DNS: Private zone linked to VNet
```

Reference: [https://learn.microsoft.com/en-us/azure/redis/private-link](https://learn.microsoft.com/en-us/azure/redis/private-link)

---

## 3. Security & Identity

**Impact: CRITICAL**

Enforce TLS 1.2/1.3, prefer Microsoft Entra authentication, and control access keys and RBAC for Azure Managed Redis.

---

### 3.1 Enforce TLS 1.2+ for All Client Connections

**Impact: CRITICAL (protects data in transit)**

Azure Managed Redis only supports TLS 1.2 and 1.3 and requires TLS by default. Do not enable non-TLS access in production; keep TLS enforced to protect data in transit and meet compliance requirements.

**Incorrect: allow non-TLS access**

```text
Advanced settings: Non-TLS access enabled
Client port: 10000 (plaintext allowed)
```

**Correct: TLS enforced**

```text
Advanced settings: Non-TLS access disabled
Client port: 10000 (TLS only)
```

Reference: [https://learn.microsoft.com/en-us/azure/redis/tls-configuration](https://learn.microsoft.com/en-us/azure/redis/tls-configuration)

### 3.2 Prefer Microsoft Entra Authentication Over Access Keys

**Impact: CRITICAL (reduces key management risk)**

Azure Managed Redis supports password-free Microsoft Entra authentication and enables managed identity by default. Use Entra tokens for authentication and refresh tokens before expiry; keep access keys disabled unless a client can't support Entra.

**Incorrect: access keys only**

```text
Authentication: Access keys enabled
Entra authentication: Disabled
Token refresh: Not implemented
```

**Correct: Entra authentication with token refresh**

```text
Authentication: Microsoft Entra enabled
Access keys: Disabled
Client: refreshes token before expiry and re-AUTHs
```

Reference: [https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication](https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication)

### 3.3 Rotate Access Keys and Keep Secrets Out of Code

**Impact: CRITICAL (reduces credential exposure and recovery time)**

Prefer Microsoft Entra authentication for Azure Managed Redis. If a legacy client still requires access keys, treat the keys as break-glass credentials: store them in Key Vault or an approved secret store, reference them from managed runtime configuration, and maintain a rotation runbook that validates clients can reconnect after key changes. Never commit Redis keys, connection strings, or tokens to source control, images, IaC parameter files, or eval prompts.

**Incorrect: static key embedded in deployment artifacts**

```text
Authentication: access key
Storage: appsettings.json committed to repo
Rotation: none
Client rollout: all instances use the same static value
Incident response: no owner or rollback plan
```

**Correct: controlled exception with rotation hygiene**

```text
Authentication: Entra for supported clients; access key exception documented
Storage: Key Vault secret referenced by managed identity
Rotation: scheduled and tested with primary/secondary key rollover
Client rollout: staged restart or hot reload from secret reference
Incident response: owner, validation query, rollback, and audit trail
```

Reference: [https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication](https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication), [https://learn.microsoft.com/en-us/azure/key-vault/secrets/about-secrets](https://learn.microsoft.com/en-us/azure/key-vault/secrets/about-secrets)

### 3.4 Scope Data Access Policies to Identities and Key Patterns

**Impact: CRITICAL (limits blast radius for compromised identities)**

Azure Managed Redis uses Microsoft Entra identities for password-free access, but newly assigned users or service principals can receive broad command and key permissions unless you scope them. Assign managed identities or service principals per workload, use custom data access policies where available, and express least privilege with Redis ACL syntax such as command categories and key patterns. Track each access policy assignment as infrastructure so reviews and removals are auditable.

**Incorrect: shared identity with full data-plane access**

```text
Identity: shared application service principal
Access policy: +@all ~*
Key patterns: unrestricted
Commands: all commands not otherwise blocked by AMR
Review process: manual portal assignment
```

**Correct: least-privilege identity and key scope**

```text
Identity: workload-specific managed identity object ID
Access policy assignment: managed in IaC
Access string: +@read +@write ~checkout:* ~session:*
Admin/destructive commands: not granted unless explicitly required
Review process: quarterly identity and ACL review
```

Reference: [https://learn.microsoft.com/en-us/azure/redis/configure-access-permissions](https://learn.microsoft.com/en-us/azure/redis/configure-access-permissions), [https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication](https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication)

---

## 4. Availability & Zone Redundancy

**Impact: HIGH**

Enable high availability and zone redundancy to survive node and zone failures in Azure regions with availability zones.

---

### 4.1 Enable High Availability and Zone Redundancy

**Impact: HIGH (improves resilience to node and zone failures)**

Azure Managed Redis recommends high availability for production, which deploys multiple nodes and replicates data across them. In regions with availability zones, enable zone redundancy to place nodes in separate zones for better resilience.

**Incorrect: single node, no zone redundancy**

```text
High Availability: Disabled
Zone Redundancy: Not configured
```

**Correct: HA with zone redundancy in supported regions**

```text
High Availability: Enabled
Zone Redundancy: Enabled
Region: supports availability zones
```

Reference: [https://learn.microsoft.com/en-us/azure/reliability/reliability-managed-redis](https://learn.microsoft.com/en-us/azure/reliability/reliability-managed-redis)

---

## 5. Geo-Replication & DR

**Impact: HIGH**

Plan active geo-replication groups, eventual consistency behavior, and DR workflows for multi-region continuity.

---

### 5.1 Plan Active Geo-Replication for Multi-Region DR

**Impact: HIGH (reduces regional outage risk)**

Active geo-replication groups up to five Azure Managed Redis instances across regions in an active-active configuration. Plan for eventual consistency and enable geo-replication during provisioning because caches without it cannot join a group later. Ensure all instances use the same configuration.

**Incorrect: assume you can add geo-replication later or mix configs**

```text
ActiveGeoReplication: Disabled at creation
Region B: different SKU and modules
Consistency expectations: strong, synchronous
```

**Correct: enable at creation and design for eventual consistency**

```text
ActiveGeoReplication: Enabled at creation
All regions: same SKU, modules, policies
Consistency expectations: eventual
```

Reference: [https://learn.microsoft.com/en-us/azure/redis/how-to-active-geo-replication](https://learn.microsoft.com/en-us/azure/redis/how-to-active-geo-replication)

---

## 6. Data Durability & Backup

**Impact: MEDIUM-HIGH**

Configure RDB/AOF persistence for node recovery and use export for backups and migration. Covers limitations and feature incompatibilities.

---

### 6.1 Configure Persistence for Node Recovery, Use Export for Backups

**Impact: MEDIUM-HIGH (reduces data loss on node failures)**

Azure Managed Redis persistence (RDB or AOF) helps recover data after node failures but is not a point-in-time backup feature. Persisted files cannot be used to restore to another cache; use the export feature for backups and migrations. Persistence requires high availability and is not supported with active geo-replication.

**Incorrect: treat persistence as backup or combine with geo-replication**

```text
Persistence: Enabled
ActiveGeoReplication: Enabled
Backup plan: rely on RDB files for restore to new cache
```

**Correct: use persistence for recovery and export for backups**

```text
High Availability: Enabled
Persistence: RDB or AOF enabled
ActiveGeoReplication: Disabled
Backup plan: scheduled export to Blob storage
```

Reference: [https://learn.microsoft.com/en-us/azure/redis/how-to-persistence](https://learn.microsoft.com/en-us/azure/redis/how-to-persistence), [https://learn.microsoft.com/en-us/azure/redis/how-to-import-export-data](https://learn.microsoft.com/en-us/azure/redis/how-to-import-export-data)

---

## 7. Performance & Cluster Policy

**Impact: MEDIUM**

Choose OSS vs Enterprise cluster policy, understand port requirements, and align client capabilities with throughput goals.

---

### 7.1 Choose Cluster Policy Based on Client and Module Needs

**Impact: MEDIUM (prevents client incompatibility and throughput bottlenecks)**

Azure Managed Redis supports OSS, Enterprise, and Non-clustered policies. OSS clustering provides the best throughput but requires Redis Cluster-capable clients and uses additional shard ports. Enterprise clustering uses a proxy endpoint and is required for RediSearch and RedisJSON modules. Choose the policy based on client capabilities and module requirements.

**Incorrect: select OSS when clients and modules require Enterprise**

```text
Cluster policy: OSS
Client library: not Redis Cluster-aware
Modules: RediSearch enabled
```

**Correct: align policy with client/module requirements**

```text
Cluster policy: Enterprise
Client library: standard Redis client
Modules: RediSearch/RedisJSON enabled
```

Reference: [https://learn.microsoft.com/en-us/azure/redis/architecture](https://learn.microsoft.com/en-us/azure/redis/architecture)

---

## 8. Observability & Diagnostics

**Impact: MEDIUM**

Configure Azure Monitor metrics and diagnostic logs, enable connection auditing, and set alerting for AMR performance and security.

### 8.1 Enable Azure Monitor Metrics and Connection Logs

**Impact: MEDIUM (improves operational visibility and auditing)**

Azure Managed Redis emits metrics and diagnostic logs through Azure Monitor. Enable metrics (AllMetrics) and connection logs to capture performance signals and authentication events, and send them to Log Analytics or storage for alerting and auditing.

**Incorrect: no diagnostics enabled**

```text
Diagnostic settings: Disabled
Metrics: Not exported
Connection logs: Off
```

**Correct: metrics and connection logs enabled**

```text
Diagnostic settings: Enabled
Categories: AllMetrics, Connection logs
Destination: Log Analytics workspace
```

Reference: [https://learn.microsoft.com/en-us/azure/redis/monitor-diagnostic-settings](https://learn.microsoft.com/en-us/azure/redis/monitor-diagnostic-settings)

### 8.2 Set Azure Monitor Alert Baselines Before Launch

**Impact: HIGH (shortens detection and response time)**

Azure Managed Redis platform metrics are collected automatically, but production readiness requires alert rules, action groups, dashboards, and runbook links before traffic arrives. Baseline thresholds from load tests and expected traffic, then alert on saturation, client pressure, latency, evictions, CPU/server load, connection anomalies, and geo-replication health where used. Route diagnostic settings to Log Analytics so alerts can be investigated with connection logs and historical metrics.

**Incorrect: dashboards only, no actionable alerts**

```text
Metrics: viewed manually in portal
Diagnostic settings: disabled
Alerts: none
Action group: none
Runbook: tribal knowledge
Thresholds: not tied to load test or SLO
```

**Correct: launch baseline with alert routing**

```text
Diagnostic settings: AllMetrics and Connection logs to Log Analytics
Metric alerts: usedmemorypercentage, serverLoad, percentProcessorTime
Metric alerts: connectedclients, cacheLatency, evictedkeys
Geo alerts: geoReplicationHealthy when active geo-replication is enabled
Actions: on-call action group with severity, owner, and runbook URL
Review: tune thresholds after load test and first production week
```

Reference: [https://learn.microsoft.com/en-us/azure/redis/monitor-cache](https://learn.microsoft.com/en-us/azure/redis/monitor-cache), [https://learn.microsoft.com/en-us/azure/redis/monitor-cache-reference](https://learn.microsoft.com/en-us/azure/redis/monitor-cache-reference)

---

## References

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
