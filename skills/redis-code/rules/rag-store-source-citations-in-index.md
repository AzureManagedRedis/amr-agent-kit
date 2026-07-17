---
title: Store Source and Citation Metadata for RAG
impact: HIGH
impactDescription: supports traceability and hallucination reduction
tags: rag, citations, grounding, metadata
---

## Store Source and Citation Metadata for RAG

Persist citation metadata with each chunk (source URL, title, section, document version). Without citation fields, responses cannot reliably reference evidence or support trust and auditing requirements.

**Incorrect (chunk text only):**

```json
{
  "chunk": "Refunds are processed in 5 business days.",
  "embedding": [0.41, 0.22, -0.05]
}
```

**Correct (grounded chunk record):**

```json
{
  "docId": "policy-2026-02",
  "chunkId": "policy-2026-02:14",
  "title": "Refund Policy",
  "sourceUrl": "https://contoso.example/policies/refunds",
  "version": "2026-02",
  "chunk": "Refunds are processed in 5 business days.",
  "embedding": [0.41, 0.22, -0.05]
}
```

Reference: [Redis RAG patterns](https://redis.io/docs/latest/develop/get-started/rag/)
