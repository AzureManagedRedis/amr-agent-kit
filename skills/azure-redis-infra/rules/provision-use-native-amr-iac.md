---
title: Generate Native AMR Infrastructure as Code
impact: CRITICAL
impactDescription: prevents invalid or incomplete AMR deployments
tags: provisioning, iac, arm, bicep, terraform, private-link
---

## Generate Native AMR Infrastructure as Code

Generate Azure Managed Redis infrastructure using native AMR resource shapes. Capture cluster-level settings, database-level settings, Private Link, diagnostics, and access controls explicitly so production deployments are reviewable before provisioning.

**Incorrect (incomplete generic Redis shape):**

```text
Resource: one cache resource only
Database settings: omitted
Port/protocol: implicit
Cluster policy: implicit default
Private connectivity: no private endpoint or DNS zone group
```

**Correct (native ARM/Bicep shape):**

```text
Cluster: Microsoft.Cache/redisEnterprise
Database: Microsoft.Cache/redisEnterprise/databases named <cacheName>/default
Cluster properties: minimumTlsVersion, publicNetworkAccess, identity, tags
Database properties: port 10000, clientProtocol, clusteringPolicy, evictionPolicy, modules, persistence
Networking: private endpoint with group id redisEnterprise and DNS zone privatelink.redis.azure.net
Operations: diagnostic settings, alerts, and access policy assignments
```

For ARM and Bicep, model the AMR cluster and the `default` database separately. The database resource depends on the cluster and holds data-plane settings such as `port: 10000`, `clientProtocol`, `clusteringPolicy`, `evictionPolicy`, modules, persistence, and geo-replication settings. Keep applications configured for `<cache-name>.<region>.redis.azure.net`.

For Terraform, use the latest `azurerm` provider documented in the Terraform Registry and model AMR with `azurerm_managed_redis` plus a `default_database` block:

```hcl
resource "azurerm_managed_redis" "redis" {
  name                      = var.name
  location                  = var.location
  resource_group_name       = var.resource_group_name
  sku_name                  = var.sku_name
  public_network_access     = "Disabled"
  high_availability_enabled = true

  default_database {
    client_protocol   = "Encrypted"
    clustering_policy = var.clustering_policy
    eviction_policy   = var.eviction_policy
  }

  tags = var.tags
}

resource "azurerm_private_endpoint" "redis" {
  name                = "${var.name}-pe"
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = var.subnet_id

  private_service_connection {
    name                           = "redisEnterprise"
    private_connection_resource_id = azurerm_managed_redis.redis.id
    subresource_names              = ["redisEnterprise"]
    is_manual_connection           = false
  }
}
```

Use the private DNS zone `privatelink.redis.azure.net` for AMR private endpoints. In Terraform, prefer provider-supported attributes and modules for diagnostics, role assignments, private DNS zone links, and private endpoint DNS zone groups rather than shelling out to CLI commands. Validate Terraform with `terraform validate` before `terraform plan`, and validate ARM/Bicep deployments with `what-if`.

Reference: [Azure Managed Redis ARM templates](https://learn.microsoft.com/en-us/azure/templates/microsoft.cache/redisenterprise), [Azure Managed Redis Terraform resource](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/managed_redis), [Azure Managed Redis Private Link](https://learn.microsoft.com/en-us/azure/redis/private-link)
