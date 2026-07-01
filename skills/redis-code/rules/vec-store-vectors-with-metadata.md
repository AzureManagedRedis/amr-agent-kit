---
title: Store Vectors with Filterable Metadata
impact: CRITICAL
impactDescription: enables high-quality retrieval and hybrid filtering
tags: vectors, metadata, redisjson, redisearch
---

## Store Vectors with Filterable Metadata

Store embeddings together with filterable metadata (for example tenant, ACL or policy boundary, category, language, source URI, document version, knowledge-base version, and updated timestamp). Vector-only records reduce retrieval precision, break citations, and prevent efficient hybrid filtering.

**Incorrect (vector without retrieval metadata):**

```json
{
  "id": "doc:1001",
  "embedding": [0.12, -0.04, 0.88]
}
```

**Correct (vector with metadata used for filtering and grounding):**

```json
{
  "id": "doc:1001",
  "tenant": "contoso",
  "acl": "support-tier-2",
  "category": "billing",
  "language": "en",
  "source_uri": "https://storage.example/kb/billing.pdf",
  "doc_version": "etag-or-version-id",
  "knowledge_base_version": "kb-2026-02-01",
  "updatedAt": 1739059200,
  "embedding": [0.12, -0.04, 0.88]
}
```

Reference: [Redis vector search](https://redis.io/docs/latest/develop/ai/search-and-query/vectors/)
