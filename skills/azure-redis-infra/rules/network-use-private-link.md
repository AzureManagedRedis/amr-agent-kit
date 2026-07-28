---
title: Use Private Link and Disable Public Network Access
impact: CRITICAL
impactDescription: reduces exposure to the public internet
tags: networking, private-link, private-endpoint, public-network-access
---

## Use Private Link and Disable Public Network Access

Azure Managed Redis recommends Private Link for secure network isolation. For production, create a private endpoint for `Microsoft.Cache/redisEnterprise` using group id `redisEnterprise`, disable public network access, and configure DNS so clients resolve the normal cache hostname to the private IP.

**Incorrect (public endpoint exposed):**

```text
Networking: Public access enabled
Private Endpoint: Not configured
DNS: Public hostname resolution
```

**Correct (private endpoint and public access disabled):**

```text
Networking: Private Endpoint
Private endpoint target: Microsoft.Cache/redisEnterprise
Group id: redisEnterprise
PublicNetworkAccess: Disabled
DNS: Private zone linked to VNet
NSG/UDR controls: applied around the private endpoint subnet and workload subnets
```

Keep application clients on the service-returned normal host name and database port with TLS. Private DNS should make that host name resolve to the private endpoint IP; do not point clients directly at a `privatelink` host name. In IaC, include the private endpoint DNS zone group or private DNS zone links for every client network. In public Azure the Gen2 private zone is `privatelink.redis.azure.net`; use the current cloud's documented/resource-provided suffix rather than hardcoding the public-cloud value.

Reference: [Azure Managed Redis Private Link](https://learn.microsoft.com/en-us/azure/redis/private-link)
