---
title: Configure Persistence for Node Recovery, Use Export for Backups
impact: MEDIUM-HIGH
impactDescription: reduces data loss on node failures
tags: durability, persistence, rdb, aof, export, backup
---

## Configure Persistence for Node Recovery, Use Export for Backups

Azure Managed Redis persistence (RDB or AOF) helps recover data after node failures but is not a point-in-time backup feature. Persisted files cannot be used to restore to another cache; use the export feature for backups and migrations. Persistence requires high availability and is not supported with active geo-replication. Persistence storage is managed by AMR, so IaC should configure persistence frequency and mode rather than external storage connection strings.

**Incorrect (treat persistence as backup or combine with geo-replication):**

```text
Persistence: Enabled
ActiveGeoReplication: Enabled
Backup plan: rely on RDB files for restore to new cache
```

**Correct (use persistence for recovery and export for backups):**

```text
High Availability: Enabled
Persistence: RDB or AOF enabled
Persistence storage: managed by AMR
ActiveGeoReplication: Disabled
Backup plan: scheduled export to Blob storage
```

Reference: [Configure data persistence](https://learn.microsoft.com/en-us/azure/redis/how-to-persistence), [Import and export data](https://learn.microsoft.com/en-us/azure/redis/how-to-import-export-data)
