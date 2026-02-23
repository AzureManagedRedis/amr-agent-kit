---
title: Use Private Link and Disable Public Network Access
impact: CRITICAL
impactDescription: reduces exposure to the public internet
tags: networking, private-link, private-endpoint, public-network-access
---

## Use Private Link and Disable Public Network Access

Azure Managed Redis recommends Private Link for secure network isolation. For production, create a private endpoint and disable public network access so traffic stays inside the VNet. Configure DNS so clients resolve the cache hostname to the private IP.

**Incorrect (public endpoint exposed):**

```text
Networking: Public access enabled
Private Endpoint: Not configured
DNS: Public hostname resolution
```

**Correct (private endpoint and public access disabled):**

```text
Networking: Private Endpoint
PublicNetworkAccess: Disabled
DNS: Private zone linked to VNet
```

Reference: [Azure Managed Redis Private Link](https://learn.microsoft.com/en-us/azure/redis/private-link)
