---
title: Make Embedding Ingestion Idempotent
impact: HIGH
impactDescription: prevents duplicate chunks and stale vectors during re-indexing
tags: embeddings, ingestion, idempotency, rag, upsert
---

## Make Embedding Ingestion Idempotent

Use deterministic chunk IDs and content fingerprints when writing embeddings. Random IDs or append-only ingestion create duplicate vectors, stale search results, and inconsistent citations when documents are reprocessed.

For Azure Blob Storage ingestion, treat Blob Event Grid notifications as triggers, not proof that work is unique. Use the blob URI plus ETag/version, content hash, embedding model, and chunk window to derive stable chunk IDs; then upsert current chunks and delete stale chunks from the document manifest.

**Incorrect (new random vector IDs on every run):**

```python
for chunk in chunk_document(document):
    redis_client.hset(
        f"rag:chunk:{uuid4()}",
        mapping={"doc_id": document.id, "text": chunk.text, "embedding": embed(chunk.text)},
    )
```

**Correct (stable IDs, manifest, and stale chunk cleanup):**

```python
manifest_key = f"rag:doc:{tenant_id}:{document.id}:chunks"
to_text = lambda value: value.decode() if isinstance(value, bytes) else value
existing = {to_text(key) for key in redis_client.smembers(manifest_key)}
seen = set()
pipe = redis_client.pipeline()

for chunk in chunk_document(document):
    fingerprint = sha256(f"{embedding_model}:{chunk.text}".encode()).hexdigest()
    chunk_key = f"rag:chunk:{tenant_id}:{document.id}:{fingerprint[:16]}"
    seen.add(chunk_key)
    pipe.hset(chunk_key, mapping={
        "doc_id": document.id,
        "source_uri": document.source_uri,
        "doc_version": document.version,
        "content_hash": fingerprint,
        "embedding_model": embedding_model,
        "knowledge_base_version": knowledge_base_version,
        "text": chunk.text,
        "embedding": embed(chunk.text),
    })
    pipe.sadd(manifest_key, chunk_key)

stale = existing - seen
if stale:
    pipe.delete(*stale)
    pipe.srem(manifest_key, *stale)
pipe.execute()
```

Reference: [Redis vector search](https://redis.io/docs/latest/develop/ai/search-and-query/vectors/)
