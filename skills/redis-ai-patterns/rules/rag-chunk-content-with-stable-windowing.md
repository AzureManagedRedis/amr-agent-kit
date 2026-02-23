---
title: Chunk Documents with Stable Size and Overlap
impact: HIGH
impactDescription: improves retrieval quality and grounding consistency
tags: rag, chunking, retrieval, embeddings
---

## Chunk Documents with Stable Size and Overlap

Use consistent chunking boundaries (for example 400-800 tokens with overlap) so semantically related context stays together. Very large or inconsistent chunks reduce retrieval quality and inflate prompt tokens.

**Incorrect (single large chunk per document):**

```text
Document length: 12,000 tokens
Chunks: 1
Overlap: 0
```

**Correct (stable chunking strategy):**

```text
Chunk size: 600 tokens
Overlap: 120 tokens
Chunk metadata: docId, chunkId, section, sourceUrl
```

Reference: [Redis RAG patterns](https://redis.io/docs/latest/develop/get-started/rag/)
