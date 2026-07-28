---
title: Scope Data Access Policies to Identities and Key Patterns
impact: CRITICAL
impactDescription: limits blast radius for compromised identities
tags: security, entra, rbac, data-access, acl, least-privilege
---

## Scope Data Access Policies to Identities and Key Patterns

Azure Managed Redis uses Microsoft Entra identities for password-free access, but newly assigned users or service principals can receive broad command and key permissions unless you scope them. Do not build tenant isolation on Redis logical-database indexes: under clustered policies (OSSCluster, EnterpriseCluster) and under active geo-replication, only database 0 is available and `SELECT` to another index is not supported; under `NoCluster`, do not assume either single-database or multi-database behavior without confirming it from the database's effective configuration or a live `SELECT` capability check. A single managed `default` database resource in the control or data plane does not by itself prove how many logical databases the endpoint exposes. Regardless of cluster policy, express tenant and workload boundaries through identities and key patterns rather than numbered DB indexes. Assign managed identities or service principals per workload, use custom data access policies where available, and express least privilege with Redis ACL syntax such as command categories and key patterns. Track each access policy assignment as infrastructure so reviews and removals are auditable.

**Incorrect (shared identity with full data-plane access):**

```text
Identity: shared application service principal
Access policy: +@all ~*
Key patterns: unrestricted
Commands: all commands not otherwise blocked by AMR
Review process: manual portal assignment
```

**Correct (least-privilege identity and key scope):**

```text
Identity: workload-specific managed identity object ID
Access policy assignment: managed in IaC
Access string: +@read +@write ~checkout:* ~session:*
Admin/destructive commands: not granted unless explicitly required
Review process: quarterly identity and ACL review
```

When you find a migration design that uses database indexes for tenant isolation, refactor the infrastructure plan to key-pattern boundaries and identity boundaries: provision workload-specific managed identities, assign data access policies scoped to prefixes such as `prod:tenant:contoso:*`, and use separate AMR caches for tenants that require hard isolation, independent maintenance windows, or separate compliance controls. Application code still needs tenant-aware key builders and authorization checks; access policies reduce blast radius but do not replace application authorization.

Reference: [Configure custom data access permissions](https://learn.microsoft.com/en-us/azure/redis/configure-access-permissions), [Use Microsoft Entra for cache authentication](https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication)
