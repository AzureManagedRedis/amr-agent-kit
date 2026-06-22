# Redis AI Patterns

**Version 1.0.0**  
Microsoft  
February 2026

> **Note:**  
> This document is mainly for agents and LLMs to follow when maintaining,  
> generating, or refactoring AI applications using Redis. Humans  
> may also find it useful, but guidance here is optimized for automation  
> and consistency by AI-assisted workflows.

---

## Abstract

Patterns and best practices for building AI and ML applications with Redis on Azure Managed Redis (Redis Enterprise 7.4). Covers vector storage and indexing, similarity search, RAG implementation, semantic caching, LLM memory management, AI agent state orchestration, framework integration, and performance tuning. Contains 24 rules across 9 categories with incorrect vs. correct examples and references to official Azure and Redis documentation.

---

## Table of Contents

1. [Vector Storage & Indexing](#1-vector-storage--indexing) — **CRITICAL**
   - 1.1 [Keep Embedding Dimensions and Distance Metric Aligned](#11-keep-embedding-dimensions-and-distance-metric-aligned)
   - 1.2 [Store Vectors with Filterable Metadata](#12-store-vectors-with-filterable-metadata)
2. [Similarity Search](#2-similarity-search) — **CRITICAL**
   - 2.1 [Limit K and Returned Fields for AI Retrieval](#21-limit-k-and-returned-fields-for-ai-retrieval)
   - 2.2 [Use Enterprise Cluster Policy for RediSearch and RedisJSON](#22-use-enterprise-cluster-policy-for-redisearch-and-redisjson)
   - 2.3 [Use Hybrid Vector Search with Metadata Filters](#23-use-hybrid-vector-search-with-metadata-filters)
3. [RAG Implementation](#3-rag-implementation) — **HIGH**
   - 3.1 [Chunk Documents with Stable Size and Overlap](#31-chunk-documents-with-stable-size-and-overlap)
   - 3.2 [Enforce Tenant and ACL Boundaries in RAG](#32-enforce-tenant-and-acl-boundaries-in-rag)
   - 3.3 [Store Source and Citation Metadata for RAG](#33-store-source-and-citation-metadata-for-rag)
4. [Semantic Caching](#4-semantic-caching) — **HIGH**
   - 4.1 [Invalidate Semantic Cache on Knowledge and Policy Changes](#41-invalidate-semantic-cache-on-knowledge-and-policy-changes)
   - 4.2 [Tune Semantic Cache Threshold and TTL by Use Case](#42-tune-semantic-cache-threshold-and-ttl-by-use-case)
   - 4.3 [Version Semantic Cache Keys by Model and Prompt](#43-version-semantic-cache-keys-by-model-and-prompt)
5. [LLM Memory & Sessions](#5-llm-memory--sessions) — **HIGH**
   - 5.1 [Set TTL and Sliding Windows for LLM Session Memory](#51-set-ttl-and-sliding-windows-for-llm-session-memory)
   - 5.2 [Summarize Older Turns to Preserve Context Budget](#52-summarize-older-turns-to-preserve-context-budget)
6. [AI Agent Patterns](#6-ai-agent-patterns) — **MEDIUM-HIGH**
   - 6.1 [Persist Agent State and Checkpoints in Redis](#61-persist-agent-state-and-checkpoints-in-redis)
   - 6.2 [Resume Agents from Idempotent Checkpoints](#62-resume-agents-from-idempotent-checkpoints)
   - 6.3 [Use Redis Streams for Multi-Step Agent Workflows](#63-use-redis-streams-for-multi-step-agent-workflows)
7. [Embeddings & Models](#7-embeddings--models) — **MEDIUM**
   - 7.1 [Batch Embedding Generation and Redis Upserts](#71-batch-embedding-generation-and-redis-upserts)
   - 7.2 [Make Embedding Ingestion Idempotent](#72-make-embedding-ingestion-idempotent)
   - 7.3 [Standardize One Embedding Model per Index](#73-standardize-one-embedding-model-per-index)
8. [Framework Integration](#8-framework-integration) — **MEDIUM**
   - 8.1 [Use Microsoft Agent Framework with Redis for Durable Agent State](#81-use-microsoft-agent-framework-with-redis-for-durable-agent-state)
   - 8.2 [Use RedisVL for Index Schema and Query Lifecycle](#82-use-redisvl-for-index-schema-and-query-lifecycle)
9. [Performance Tuning](#9-performance-tuning) — **LOW-MEDIUM**
   - 9.1 [Pipeline Bulk Vector Ingestion](#91-pipeline-bulk-vector-ingestion)
   - 9.2 [Size for Vector Workloads and Memory Footprint](#92-size-for-vector-workloads-and-memory-footprint)
   - 9.3 [Tune HNSW Runtime Parameters for SLA Targets](#93-tune-hnsw-runtime-parameters-for-sla-targets)

---

## 1. Vector Storage & Indexing

**Impact: CRITICAL**

Proper vector storage and indexing is fundamental to AI application performance. Covers storing embeddings in Redis hashes or JSON, choosing between HNSW and FLAT indexes, configuring index parameters (M, EF_CONSTRUCTION, EF_RUNTIME), and dimension considerations.

---

### 1.1 Keep Embedding Dimensions and Distance Metric Aligned

**Impact: CRITICAL (prevents query failures and relevance degradation)**

Each vector index must use a single embedding dimension and a metric aligned with the selected model. Mixing dimensions or changing metrics without rebuilding the index causes runtime errors or poor ranking quality.

**Incorrect: mixed model dimensions in one index**

```text
Index DIM=1536
Inserted vectors: [1536, 1536, 3072]
Query result: dimension mismatch errors
```

**Correct: one model configuration per index**

```text
index: kb-v1
model: text-embedding-3-small
dimension: 1536
metric: COSINE
```

Reference: [https://redis.io/docs/latest/develop/ai/search-and-query/vectors/](https://redis.io/docs/latest/develop/ai/search-and-query/vectors/)

### 1.2 Store Vectors with Filterable Metadata

**Impact: CRITICAL (enables high-quality retrieval and hybrid filtering)**

Store embeddings together with filterable metadata (for example tenant, category, language, updated timestamp). Vector-only records reduce retrieval precision and prevent efficient hybrid filtering.

**Incorrect: vector without retrieval metadata**

```json
{
  "id": "doc:1001",
  "embedding": [0.12, -0.04, 0.88]
}
```

**Correct: vector with metadata used for filtering and grounding**

```json
{
  "id": "doc:1001",
  "tenant": "contoso",
  "category": "billing",
  "language": "en",
  "source": "kb",
  "updatedAt": 1739059200,
  "embedding": [0.12, -0.04, 0.88]
}
```

Reference: [https://redis.io/docs/latest/develop/ai/search-and-query/vectors/](https://redis.io/docs/latest/develop/ai/search-and-query/vectors/)

---

## 2. Similarity Search

**Impact: CRITICAL**

Effective similarity search is core to vector database usage. Covers KNN queries, range queries, distance metrics (cosine, L2, IP), and result scoring.

---

### 2.1 Limit K and Returned Fields for AI Retrieval

**Impact: HIGH (lowers latency and payload size for inference)**

Set K based on downstream context window and return only required fields. Oversized K values and wide payloads increase query latency and token usage without improving answer quality.

**Incorrect: oversized payload**

```text
K=200
RETURN *
```

**Correct: minimal retrieval contract**

```text
K=8..20 (based on use case)
RETURN docId, chunkText, source, score
```

Reference: [https://learn.microsoft.com/en-us/azure/redis/architecture](https://learn.microsoft.com/en-us/azure/redis/architecture)

### 2.2 Use Enterprise Cluster Policy for RediSearch and RedisJSON

**Impact: CRITICAL (avoids unsupported module/cluster combinations)**

On Azure Managed Redis, RediSearch and RedisJSON require the Enterprise cluster policy. OSS cluster policy doesn't support RediSearch. Select the Enterprise policy at provisioning time when you need vector search or JSON documents.

**Incorrect: OSS cluster with RediSearch/RedisJSON**

```text
Cluster policy: OSS
Modules: RediSearch, RedisJSON
Result: module not supported with OSS policy
```

**Correct: Enterprise cluster with modules**

```text
Cluster policy: Enterprise
Modules: RediSearch, RedisJSON
Result: vector search and JSON features available
```

Reference: [https://learn.microsoft.com/en-us/azure/redis/architecture](https://learn.microsoft.com/en-us/azure/redis/architecture)

### 2.3 Use Hybrid Vector Search with Metadata Filters

**Impact: CRITICAL (improves retrieval precision and prevents unsafe post-filtering)**

Combine vector similarity with metadata filters in the Redis query itself. Pulling broad top-K results and filtering in application code can drop relevant results, increase latency, and expose records from the wrong tenant, locale, status, or entitlement boundary.

**Incorrect: filtering after broad vector retrieval**

```python
query = Query("*=>[KNN 50 @embedding $vec AS score]").sort_by("score")
results = redis_client.ft("idx:kb").search(query, {"vec": query_vector})

allowed = [
    doc for doc in results.docs
    if doc.tenant_id == tenant_id
    and doc.locale == locale
    and doc.access_tier in user_access_tiers
]
```

**Correct: hybrid filter and vector search in one query**

```python
tenant = escape_tag(tenant_id)
locale_tag = escape_tag(locale)
access = "|".join(escape_tag(tier) for tier in user_access_tiers)

filter_expr = (
    f"(@tenant_id:{{{tenant}}} @locale:{{{locale_tag}}} "
    f"@access_tier:{{{access}}} @status:{{active}})"
)
query = (
    Query(f"{filter_expr}=>[KNN 8 @embedding $vec AS score]")
    .sort_by("score")
    .return_fields("chunk_id", "title", "source_url", "score")
)

results = redis_client.ft("idx:kb").search(query, {"vec": query_vector})
```

Reference: [https://redis.io/docs/latest/develop/ai/search-and-query/vectors/](https://redis.io/docs/latest/develop/ai/search-and-query/vectors/)

---

## 3. RAG Implementation

**Impact: HIGH**

Retrieval Augmented Generation patterns for enhancing LLM responses with contextual data. Covers document chunking strategies, retrieval patterns, context window management, prompt construction, and handling multiple retrieved documents.

---

### 3.1 Chunk Documents with Stable Size and Overlap

**Impact: HIGH (improves retrieval quality and grounding consistency)**

Use consistent chunking boundaries (for example 400-800 tokens with overlap) so semantically related context stays together. Very large or inconsistent chunks reduce retrieval quality and inflate prompt tokens.

**Incorrect: single large chunk per document**

```text
Document length: 12,000 tokens
Chunks: 1
Overlap: 0
```

**Correct: stable chunking strategy**

```text
Chunk size: 600 tokens
Overlap: 120 tokens
Chunk metadata: docId, chunkId, section, sourceUrl
```

Reference: [https://redis.io/docs/latest/develop/get-started/rag/](https://redis.io/docs/latest/develop/get-started/rag/)

### 3.2 Enforce Tenant and ACL Boundaries in RAG

**Impact: CRITICAL (prevents cross-tenant data leakage in retrieval-grounded responses)**

Treat tenant and access-control filters as part of the retrieval contract, not prompt instructions. Every indexed chunk should carry the fields needed to enforce tenant, user group, classification, and lifecycle status before context reaches the LLM.

**Incorrect: relying on the prompt for isolation**

```python
contexts = vector_search(user_question)
prompt = f"""
Only answer using documents for tenant {tenant_id}.

Context:
{format_context(contexts)}
"""
```

**Correct: fail closed and filter retrieval by tenant and ACL**

```python
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
    Query(query_text).sort_by("score"),
    {"vec": question_vector},
)
```

Reference: [https://redis.io/docs/latest/develop/get-started/rag/](https://redis.io/docs/latest/develop/get-started/rag/)

### 3.3 Store Source and Citation Metadata for RAG

**Impact: HIGH (supports traceability and hallucination reduction)**

Persist citation metadata with each chunk (source URL, title, section, document version). Without citation fields, responses cannot reliably reference evidence or support trust and auditing requirements.

**Incorrect: chunk text only**

```json
{
  "chunk": "Refunds are processed in 5 business days.",
  "embedding": [0.41, 0.22, -0.05]
}
```

**Correct: grounded chunk record**

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

Reference: [https://redis.io/docs/latest/develop/get-started/rag/](https://redis.io/docs/latest/develop/get-started/rag/)

---

## 4. Semantic Caching

**Impact: HIGH**

Semantic caching reduces LLM costs and latency by returning cached responses for semantically similar queries. Covers similarity thresholds, cache key design, TTL strategies, cache invalidation, and handling cache misses.

---

### 4.1 Invalidate Semantic Cache on Knowledge and Policy Changes

**Impact: HIGH (avoids serving stale or unauthorized generated answers)**

Semantic cache entries depend on more than the query embedding. Invalidate or version the cache when source knowledge, entitlement rules, safety policy, prompt templates, or model versions change. TTL alone is not enough for urgent corrections or access-policy updates.

**Incorrect: cache namespace ignores knowledge and policy versions**

```python
cache_key = f"semcache:{tenant_id}:{model_id}:{prompt_version}:{query_hash}"
redis_client.hset(cache_key, mapping={"answer": answer, "embedding": query_embedding})
redis_client.expire(cache_key, 86400)
```

**Correct: include corpus and policy versions in the reuse contract**

```python
corpus_version = redis_client.get(f"rag:corpus_version:{tenant_id}:support_kb")
policy_version = redis_client.get(f"ai:policy_version:{tenant_id}")

cache_key = (
    f"semcache:{tenant_id}:{model_id}:{prompt_version}:"
    f"{corpus_version}:{policy_version}:{query_hash}"
)
redis_client.hset(cache_key, mapping={
    "answer": answer,
    "embedding": query_embedding,
    "corpus_version": corpus_version,
    "policy_version": policy_version,
})
redis_client.expire(cache_key, ttl_seconds)
```

Reference: [https://redis.io/docs/latest/develop/ai/redisvl/](https://redis.io/docs/latest/develop/ai/redisvl/)

### 4.2 Tune Semantic Cache Threshold and TTL by Use Case

**Impact: HIGH (balances reuse rate with response correctness)**

Semantic cache effectiveness depends on similarity threshold and TTL strategy. A single global threshold is usually suboptimal; tune by domain criticality and data volatility.

**Incorrect: one global setting for all workloads**

```text
similarity_threshold=0.99
ttl=30 days
```

**Correct: domain-specific cache policy**

```text
FAQ bot: threshold=0.85, ttl=24h
Policy assistant: threshold=0.93, ttl=2h
Trading insights: threshold=0.95, ttl=5m
```

Reference: [https://redis.io/docs/latest/develop/ai/](https://redis.io/docs/latest/develop/ai/)

### 4.3 Version Semantic Cache Keys by Model and Prompt

**Impact: HIGH (avoids stale or incompatible cached generations)**

Include model ID and prompt template version in semantic cache keys. Reusing cache entries across model or prompt changes can return outdated or style-incompatible answers.

**Incorrect: cache key misses versioning dimensions**

```text
cache_key = "semcache:{tenant}:{query_embedding_hash}"
```

**Correct: cache key includes generation contract**

```text
cache_key = "semcache:{tenant}:{model}:{promptVersion}:{query_embedding_hash}"
```

Reference: [https://redis.io/docs/latest/develop/ai/redisvl/](https://redis.io/docs/latest/develop/ai/redisvl/)

---

## 5. LLM Memory & Sessions

**Impact: HIGH**

Managing conversation history and context for LLM applications. Covers session storage, context window sliding, memory summarization, retrieving relevant past conversations, and multi-turn dialogue patterns.

---

### 5.1 Set TTL and Sliding Windows for LLM Session Memory

**Impact: HIGH (controls memory growth and stale context risk)**

Conversation memory should use TTL and bounded history windows. Unlimited session retention increases cost, latency, and chance of stale context impacting responses.

**Incorrect: unbounded session history**

```python
for turn in conversation:
    redis_client.rpush(f"chat:{session_id}", turn)
# no trim, no expiration
```

**Correct: bounded memory with expiration**

```python
key = f"chat:{session_id}"
redis_client.rpush(key, turn_json)
redis_client.ltrim(key, -50, -1)
redis_client.expire(key, 3600)
```

Reference: [https://learn.microsoft.com/en-us/azure/redis/overview](https://learn.microsoft.com/en-us/azure/redis/overview)

### 5.2 Summarize Older Turns to Preserve Context Budget

**Impact: HIGH (improves answer quality for long-running conversations)**

For long sessions, summarize older turns and keep recent raw turns. Sending full transcripts on every request increases token cost and may degrade response quality.

**Incorrect: full transcript every request**

```text
Prompt context = all historical turns (no summarization)
```

**Correct: hybrid memory strategy**

```text
context = conversation_summary + last_N_turns + retrieved_facts
summary refreshed every 10-20 turns
```

Reference: [https://redis.io/docs/latest/develop/ai/](https://redis.io/docs/latest/develop/ai/)

---

## 6. AI Agent Patterns

**Impact: MEDIUM-HIGH**

Patterns for building AI agents with Redis as the memory and state layer. Covers agent memory persistence, tool/route selection based on semantic similarity, agentic RAG, and multi-step reasoning state management.

---

### 6.1 Persist Agent State and Checkpoints in Redis

**Impact: MEDIUM-HIGH (enables recovery and observability for agent runs)**

Store agent run state (plan, current step, tool outputs, status) in Redis so workflows can resume after failures or restarts. In-memory-only state makes agent execution brittle in distributed systems.

**Incorrect: state only in process memory**

```python
agent_state = {"run_id": run_id, "step": "retrieve", "status": "running"}
```

**Correct: durable state in Redis**

```python
redis_client.hset(
    f"agent:run:{run_id}",
    mapping={
        "step": "retrieve",
        "status": "running",
        "lastTool": "vector_search",
        "updatedAt": "2026-02-18T10:15:00Z"
    }
)
redis_client.expire(f"agent:run:{run_id}", 86400)
```

Reference: [https://redis.io/docs/latest/develop/ai/](https://redis.io/docs/latest/develop/ai/)

### 6.2 Resume Agents from Idempotent Checkpoints

**Impact: MEDIUM-HIGH (prevents repeated side effects after worker restarts)**

Persist each agent step as an idempotent checkpoint with its output location and status. On restart, load the latest checkpoint and skip completed tool calls instead of replaying the whole plan and repeating side effects.

**Incorrect: restart repeats completed tool calls**

```python
for step in plan.steps:
    output = call_tool(step.name, step.input)
    memory.append({"step": step.name, "output": output})
```

**Correct: resume from recorded step completion**

```python
checkpoint_key = f"agent:run:{run_id}:checkpoint"
to_text = lambda value: value.decode() if isinstance(value, bytes) else value
state = {to_text(key): to_text(value) for key, value in redis_client.hgetall(checkpoint_key).items()}

for step in plan.steps:
    if state.get(step.name) == "done":
        output = redis_client.get(f"agent:run:{run_id}:output:{step.name}")
        continue

    idempotency_key = f"{run_id}:{step.name}"
    output = call_tool(step.name, step.input, idempotency_key=idempotency_key)

    pipe = redis_client.pipeline()
    pipe.set(f"agent:run:{run_id}:output:{step.name}", output, ex=86400)
    pipe.hset(checkpoint_key, mapping={step.name: "done", "last_step": step.name})
    pipe.expire(checkpoint_key, 86400)
    pipe.execute()
```

Reference: [https://redis.io/docs/latest/develop/ai/](https://redis.io/docs/latest/develop/ai/)

### 6.3 Use Redis Streams for Multi-Step Agent Workflows

**Impact: MEDIUM-HIGH (provides durable sequencing and consumer coordination)**

Use Redis Streams and consumer groups for asynchronous agent stages (retrieve, reason, tool-execute, respond). Poll loops and ad-hoc queues are harder to scale and recover.

**Incorrect: manual polling queue**

```python
while True:
    task = redis_client.lpop("agent:tasks")
    if task:
        process(task)
```

**Correct: streams with consumer groups**

```python
redis_client.xadd("agent:events", {"stage": "retrieve", "runId": run_id})
redis_client.xgroup_create("agent:events", "workers", id="0", mkstream=True)
events = redis_client.xreadgroup("workers", "worker-1", {"agent:events": ">"}, count=10)
```

Reference: [https://redis.io/docs/latest/develop/data-types/streams/](https://redis.io/docs/latest/develop/data-types/streams/)

---

## 7. Embeddings & Models

**Impact: MEDIUM**

Best practices for embedding generation and model selection. Covers choosing embedding models, dimension trade-offs, normalization, batch embedding generation, and handling embedding model updates.

---

### 7.1 Batch Embedding Generation and Redis Upserts

**Impact: MEDIUM (improves ingestion throughput and reduces cost)**

Generate embeddings in batches and pipeline Redis writes during indexing. Per-document embedding calls and single-command writes increase ingestion time and API overhead.

**Incorrect: single-document ingestion loop**

```python
for doc in docs:
    vec = embed([doc])[0]
    redis_client.hset(f"doc:{doc.id}", mapping={"embedding": vec})
```

**Correct: batched embedding + pipelined writes**

```python
for batch in batched(docs, 128):
    vectors = embed([d.text for d in batch])
    pipe = redis_client.pipeline(transaction=False)
    for doc, vec in zip(batch, vectors):
        pipe.hset(f"doc:{doc.id}", mapping={"embedding": vec, "title": doc.title})
    pipe.execute()
```

Reference: [https://redis.io/docs/latest/develop/use/pipelining/](https://redis.io/docs/latest/develop/use/pipelining/)

### 7.2 Make Embedding Ingestion Idempotent

**Impact: HIGH (prevents duplicate chunks and stale vectors during re-indexing)**

Use deterministic chunk IDs and content fingerprints when writing embeddings. Random IDs or append-only ingestion create duplicate vectors, stale search results, and inconsistent citations when documents are reprocessed.

**Incorrect: new random vector IDs on every run**

```python
for chunk in chunk_document(document):
    redis_client.hset(
        f"rag:chunk:{uuid4()}",
        mapping={"doc_id": document.id, "text": chunk.text, "embedding": embed(chunk.text)},
    )
```

**Correct: stable IDs, manifest, and stale chunk cleanup**

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
        "content_hash": fingerprint,
        "embedding_model": embedding_model,
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

Reference: [https://redis.io/docs/latest/develop/ai/search-and-query/vectors/](https://redis.io/docs/latest/develop/ai/search-and-query/vectors/)

### 7.3 Standardize One Embedding Model per Index

**Impact: MEDIUM (maintains score consistency and ranking quality)**

A vector index should represent one embedding model/version contract. Mixing models in a single index produces inconsistent distance scores and unreliable nearest-neighbor results.

**Incorrect: mixed model vectors in one index**

```text
kb-index contains vectors from:
- model A (1536 dim)
- model B (3072 dim)
```

**Correct: separate index per model contract**

```text
kb-index-v1 -> model A (1536, cosine)
kb-index-v2 -> model B (3072, cosine)
```

Reference: [https://redis.io/docs/latest/develop/ai/search-and-query/vectors/](https://redis.io/docs/latest/develop/ai/search-and-query/vectors/)

---

## 8. Framework Integration

**Impact: MEDIUM**

Patterns for integrating Redis with popular AI frameworks. Covers LangChain vector stores and memory, LlamaIndex integration, Spring AI, Semantic Kernel, Microsoft Agent Framework, and RedisVL library usage.

---

### 8.1 Use Microsoft Agent Framework with Redis for Durable Agent State

**Impact: MEDIUM (improves agent reliability and restart recovery)**

When using Microsoft Agent Framework, store long-lived agent context and retrieval/session state in Redis instead of in-memory process state. This keeps multi-step workflows resilient across restarts and scale-out replicas.

**Incorrect: agent state only in memory**

```python
agent_state = {
    "session_id": session_id,
    "memory": turns,
    "last_step": "retrieve"
}
```

**Correct: persist framework state in Redis**

```python
state_key = f"maf:session:{session_id}"
redis_client.hset(
    state_key,
    mapping={
        "memory_summary": summary_text,
        "last_step": "retrieve",
        "retrieval_index": "kb-v1"
    }
)
redis_client.expire(state_key, 3600)
```

Reference: [https://learn.microsoft.com/en-us/agent-framework/](https://learn.microsoft.com/en-us/agent-framework/)

### 8.2 Use RedisVL for Index Schema and Query Lifecycle

**Impact: MEDIUM (reduces schema drift and integration errors)**

Use RedisVL to define index schema, create indexes, and run vector queries consistently. Hand-written command strings are harder to maintain and often drift from application model definitions.

**Incorrect: manual command strings across services**

```python
redis_client.execute_command("FT.CREATE idx ...")
redis_client.execute_command("FT.SEARCH idx ...")
```

**Correct: RedisVL-managed schema and querying**

```python
from redisvl.index import SearchIndex

index = SearchIndex.from_dict(schema_dict)
index.create(overwrite=False)
results = index.query(query)
```

Reference: [https://redis.io/docs/latest/develop/ai/redisvl/](https://redis.io/docs/latest/develop/ai/redisvl/)

---

## 9. Performance Tuning

**Impact: LOW-MEDIUM**

Optimizing Redis for AI workloads. Covers index optimization, batch ingestion strategies, query optimization, memory management for large vector sets, and scaling considerations.

### 9.1 Pipeline Bulk Vector Ingestion

**Impact: LOW-MEDIUM (increases indexing throughput and lowers round-trip overhead)**

Use pipelining for bulk writes during index builds and refreshes. Sending each write as a separate network round trip significantly slows ingestion at scale.

**Incorrect: one command per document**

```python
for record in records:
    redis_client.hset(record.key, mapping=record.payload)
```

**Correct: pipeline in controlled batches**

```python
for chunk in batched(records, 500):
    pipe = redis_client.pipeline(transaction=False)
    for record in chunk:
        pipe.hset(record.key, mapping=record.payload)
    pipe.execute()
```

Reference: [https://redis.io/docs/latest/develop/use/pipelining/](https://redis.io/docs/latest/develop/use/pipelining/)

### 9.2 Size for Vector Workloads and Memory Footprint

**Impact: LOW-MEDIUM (prevents latency spikes from undersized clusters)**

Vector search workloads are memory intensive and can require higher vCPU for indexing and query throughput. Estimate embedding size, index overhead, and query concurrency, then select a tier/SKU that keeps memory headroom and CPU utilization below target thresholds.

**Incorrect: size only for raw document size**

```text
Dataset: 1M vectors
Tier: Memory Optimized (small)
Sizing: based only on raw embedding bytes
```

**Correct: include index overhead and query concurrency**

```text
Dataset: 1M vectors
Tier: Compute Optimized or Balanced
Sizing: raw embeddings + index overhead + 30% headroom
```

Reference: [https://learn.microsoft.com/en-us/azure/redis/overview](https://learn.microsoft.com/en-us/azure/redis/overview)

### 9.3 Tune HNSW Runtime Parameters for SLA Targets

**Impact: LOW-MEDIUM (balances latency and recall for production search)**

Tune HNSW runtime settings (especially EF_RUNTIME) based on latency and recall requirements. Leaving defaults unchanged for every workload can miss either quality or latency targets.

**Incorrect: single static runtime setting for all workloads**

```text
EF_RUNTIME = default for every endpoint
```

**Correct: profile and tune per endpoint class**

```text
interactive search: EF_RUNTIME=80
analysis/offline: EF_RUNTIME=200
validate recall and p95 latency per release
```

Reference: [https://redis.io/docs/latest/develop/ai/search-and-query/vectors/](https://redis.io/docs/latest/develop/ai/search-and-query/vectors/)

---

## References

1. [https://learn.microsoft.com/en-us/azure/redis/overview](https://learn.microsoft.com/en-us/azure/redis/overview)
2. [https://learn.microsoft.com/en-us/azure/redis/architecture](https://learn.microsoft.com/en-us/azure/redis/architecture)
3. [https://learn.microsoft.com/en-us/azure/redis/quickstart-create-managed-redis](https://learn.microsoft.com/en-us/azure/redis/quickstart-create-managed-redis)
4. [https://redis.io/docs/latest/develop/ai/](https://redis.io/docs/latest/develop/ai/)
5. [https://redis.io/docs/latest/develop/ai/search-and-query/vectors/](https://redis.io/docs/latest/develop/ai/search-and-query/vectors/)
6. [https://redis.io/docs/latest/develop/get-started/rag/](https://redis.io/docs/latest/develop/get-started/rag/)
7. [https://redis.io/docs/latest/develop/ai/redisvl/](https://redis.io/docs/latest/develop/ai/redisvl/)
8. [https://redis.io/docs/latest/develop/ai/ecosystem-integrations/](https://redis.io/docs/latest/develop/ai/ecosystem-integrations/)
9. [https://redis.io/docs/latest/develop/data-types/streams/](https://redis.io/docs/latest/develop/data-types/streams/)
10. [https://redis.io/docs/latest/develop/use/pipelining/](https://redis.io/docs/latest/develop/use/pipelining/)
11. [https://learn.microsoft.com/en-us/agent-framework/](https://learn.microsoft.com/en-us/agent-framework/)
