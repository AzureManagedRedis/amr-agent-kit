---
title: Scope Data Access Policies to Identities and Key Patterns
impact: CRITICAL
impactDescription: limits blast radius for compromised identities
tags: security, entra, rbac, data-access, acl, least-privilege
---

## Scope Data Access Policies to Identities and Key Patterns

Azure Managed Redis supports one database per instance and blocks the `SELECT` command. Do not build tenant isolation on numbered database indexes. Instead, express tenant and workload boundaries through Redis users, key patterns, and custom data access permissions where supported. Add workload identities or service principals to Redis users, use application key prefixes for portable logical separation, and use separate AMR caches when tenants need hard isolation or independent lifecycle. Track access configuration as infrastructure so reviews and removals are auditable.

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
Redis user and custom data access permissions: managed in IaC
Access string: +@read +@write ~checkout:* ~session:*
Admin/destructive commands: not granted unless explicitly required
Review process: quarterly identity and ACL review
```

When you find a migration design that uses database indexes for tenant isolation, refactor the infrastructure plan to key-pattern boundaries and identity boundaries: provision workload-specific managed identities, add them to Redis users, configure custom permissions scoped to prefixes such as `prod:tenant:contoso:*` where supported, and use separate AMR caches for tenants that require hard isolation, independent maintenance windows, or separate compliance controls. Application code still needs tenant-aware key builders and authorization checks; Redis permissions reduce blast radius but do not replace application authorization.

Reference: [Configure custom data access permissions](https://learn.microsoft.com/en-us/azure/redis/configure-access-permissions), [Use Microsoft Entra for cache authentication](https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication), [AMR configuration](https://learn.microsoft.com/en-us/azure/redis/configure#other-configuration-information)
