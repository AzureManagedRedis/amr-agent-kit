---
title: Configure Private DNS for Private Endpoints
impact: CRITICAL
impactDescription: avoids private endpoint connectivity and TLS failures
tags: networking, private-link, private-dns, dns, private-endpoint
---

## Configure Private DNS for Private Endpoints

Private Link is only reliable when every client network resolves the Azure Managed Redis resource's host name to the private endpoint IP. Configure applications with the normal host name and database port shown for the resource; the public Azure documentation uses `<cache-name>.<region>.redis.azure.net`, port `10000`, and private DNS zone `privatelink.redis.azure.net`. Link the private zone to every spoke, AKS, management, and shared-services VNet that needs access, and add DNS forwarding for on-premises or custom DNS resolvers. Do not configure clients to use the `privatelink` host name directly.

VNet peering does not automatically propagate private DNS resolution. Validate each workload subnet separately, especially AKS node/pod networks, management jumpboxes, and shared resolver VNets.

**Incorrect (private endpoint without end-to-end DNS):**

```text
Private endpoint: Created
Application host: <cache-name>.privatelink.redis.azure.net
Linked VNets: only the endpoint VNet
On-prem/custom DNS: no conditional forwarding
Validation: no nslookup from workload subnets
```

**Correct (private DNS integrated with every client network):**

```text
Application host: service-returned hostName
Port: service-returned database port (10000 in the public Azure example)
Private DNS zone: privatelink.redis.azure.net (public Azure documentation)
VNet links: AKS spoke, app spoke, management VNet, shared resolver VNet
Custom DNS: conditional forwarding to Azure DNS/private resolver
Validation: nslookup from each client subnet returns the private endpoint IP
```

If name resolution is correct but connections still fail, check private endpoint subnet policies, effective routes, NSGs, UDRs, Azure Firewall rules, and the `/32` private endpoint route that can bypass or override expected paths. Validate with both DNS lookup and a TLS Redis client connection to the service-returned port from every participating network.

Reference: [Azure Managed Redis with Azure Private Link](https://learn.microsoft.com/en-us/azure/redis/private-link), [Azure Private Endpoint DNS configuration](https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-dns)
