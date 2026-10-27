---
title: Enforce Tenant and ACL Boundaries in RAG
impact: CRITICAL
impactDescription: prevents cross-tenant data leakage in retrieval-grounded responses
tags: rag, tenant-isolation, acl, security, metadata
---

## Enforce Tenant and ACL Boundaries in RAG

Treat tenant and access-control filters as part of the retrieval contract, not prompt instructions. Azure Managed Redis does not provide Redis DB-index multi-tenancy with `SELECT`/numbered databases, so RAG tenant isolation must be enforced with key prefixes, filterable metadata, scoped identities or data access policies, and separate AMR caches when hard tenant isolation is required. Every indexed chunk should carry the fields needed to enforce tenant, user group, classification, and lifecycle status before context reaches the LLM, plus citation and version fields such as source URI, document ID/version, page, section, content hash, embedding model, and knowledge-base version.

**Incorrect (relying on the prompt for isolation):**

```python
contexts = vector_search(user_question)
prompt = f"""
Only answer using documents for tenant {tenant_id}.

Context:
{format_context(contexts)}
"""
```

**Correct (fail closed and filter retrieval by tenant and ACL):**

```python
import numpy as np

# Must match the index schema: VECTOR ... TYPE FLOAT32.
VECTOR_DTYPE = np.float32

if not tenant_id or not user_acl_tags:
    raise ValueError("tenant and ACL context are required for RAG retrieval")

tenant = escape_tag(tenant_id)
acl_filter = "|".join(escape_tag(tag) for tag in user_acl_tags)
query_text = (
    f"(@tenant_id:{{{tenant}}} @acl:{{{acl_filter}}} "
    f"@classification:{{public|internal}} @status:{{active}})"
    f"=>[KNN 6 @embedding $vec AS score]"
)

contexts = redis_client.ft("idx:rag:shared").search(
    Query(query_text).sort_by("score").dialect(2),
    {"vec": np.asarray(question_vector, dtype=VECTOR_DTYPE).tobytes()},
)
```

The query vector's dimensions and binary data type must exactly match the indexed vector field. Change `VECTOR_DTYPE` when the schema uses a type other than `FLOAT32`.

Reference: [Redis RAG patterns](https://redis.io/docs/latest/develop/get-started/rag/)
