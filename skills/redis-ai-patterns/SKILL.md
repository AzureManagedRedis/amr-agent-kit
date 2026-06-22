---
name: redis-ai-patterns
description: |
  Patterns for building AI applications with Redis, optimized for Azure Managed
  Redis (Redis Enterprise 7.4). Use when implementing vector search, RAG,
  semantic caching, LLM memory, AI agents, embeddings, similarity search,
  RedisVL, LangChain, LlamaIndex, Semantic Kernel, Microsoft Agent Framework, or
  vector databases on Azure.
  Do NOT use for: general Redis caching/session patterns unless AI-specific,
  Azure Managed Redis infrastructure provisioning outside AI workload needs, or
  non-Redis AI architecture.
license: MIT
metadata:
  author: Microsoft
  version: "1.0.0"
---

# Redis AI Patterns

Patterns and best practices for building AI and ML applications with Redis on Azure Managed Redis. This skill covers vector search, RAG implementation, semantic caching, LLM integration, and agent state patterns tuned for AMR and Redis Enterprise 7.4 capabilities.

## Scope

- Storing and querying vector embeddings
- Building RAG (Retrieval Augmented Generation) pipelines
- Implementing semantic caching for LLM responses
- Managing conversation history and LLM memory
- Building AI agents with Redis as the memory layer
- Integrating with LangChain, LlamaIndex, Semantic Kernel, RedisVL, or Microsoft Agent Framework

## Agent Guidance

### Start with Retrieval Correctness

For vector search and RAG tasks, first confirm embedding dimensions, distance metric, index type, metadata fields, and returned fields. Retrieval quality and runtime correctness depend on these decisions before performance tuning matters.

### Use AMR Module Requirements Early

When a workload needs RediSearch or RedisJSON on Azure Managed Redis, surface the Enterprise cluster policy requirement early. Module and cluster policy choices are provisioning-time decisions.

### Separate AI Workflows

Choose the correct guidance path based on the user's intent:

| User Intent | Signal Phrases | Primary Categories |
|---|---|---|
| Store or query embeddings | "vector", "embedding", "KNN", "similarity", "index" | Vector Storage & Indexing, Similarity Search |
| Build RAG | "RAG", "retrieval", "citations", "chunks", "grounding" | RAG Implementation, Similarity Search |
| Cache LLM responses | "semantic cache", "similar prompt", "LLM cost", "latency" | Semantic Caching, Embeddings & Models |
| Manage conversation memory | "chat history", "session memory", "context window" | LLM Memory & Sessions |
| Persist agent workflows | "agent state", "checkpoint", "tool workflow", "Streams" | AI Agent Patterns, Framework Integration |

## Available Resources

- `AGENTS.md` - Full compiled guidance with expanded rules, examples, and references.
- `rules/` - Individual rule files for targeted guidance.
- `rules/_sections.md` - Category ordering, impact, and descriptions.
- `metadata.json` - Version, abstract, and reference links.

## Redis AI Workflow

1. Identify the AI pattern: vector search, RAG, semantic cache, LLM memory, or agent state.
2. Confirm embedding model, dimensions, distance metric, and index boundaries.
3. Store vectors with filterable metadata and source/citation fields when retrieval is user-facing.
4. Keep retrieval payloads narrow and tune K to the downstream context window.
5. Use TTLs, key versioning, and windowing for semantic caches and LLM sessions.
6. Validate AMR module and cluster policy requirements before recommending deployment settings.

## Rule Categories by Priority

| Priority | Category | Impact | Prefix |
|----------|----------|--------|--------|
| 1 | Vector Storage & Indexing | CRITICAL | `vec-` |
| 2 | Similarity Search | CRITICAL | `search-` |
| 3 | RAG Implementation | HIGH | `rag-` |
| 4 | Semantic Caching | HIGH | `semcache-` |
| 5 | LLM Memory & Sessions | HIGH | `llm-` |
| 6 | AI Agent Patterns | MEDIUM-HIGH | `agent-` |
| 7 | Embeddings & Models | MEDIUM | `embed-` |
| 8 | Framework Integration | MEDIUM | `integrate-` |
| 9 | Performance Tuning | LOW-MEDIUM | `perf-` |

## Quick Reference

### 1. Vector Storage & Indexing (CRITICAL)
- `vec-store-vectors-with-metadata` - Store embeddings with filterable metadata fields.
- `vec-align-dimensions-and-distance-metric` - Keep embedding dimensions and distance metric aligned.

### 2. Similarity Search (CRITICAL)
- `search-use-enterprise-policy-for-modules` - Use Enterprise policy for RediSearch and RedisJSON on AMR.
- `search-limit-k-and-returned-fields` - Keep result count and returned fields minimal.
- `search-use-hybrid-vector-and-metadata-filters` - Apply vector similarity and metadata filters in one Redis query.

### 3. RAG Implementation (HIGH)
- `rag-chunk-content-with-stable-windowing` - Chunk documents consistently with overlap.
- `rag-store-source-citations-in-index` - Store source metadata for grounding and citations.
- `rag-enforce-tenant-and-acl-boundaries` - Enforce tenant and ACL filters before context reaches the LLM.

### 4. Semantic Caching (HIGH)
- `semcache-set-threshold-and-ttl-by-use-case` - Tune semantic threshold and TTL by workload.
- `semcache-version-keys-by-model-and-prompt` - Version cache keys by model and prompt template.
- `semcache-invalidate-on-knowledge-and-policy-changes` - Invalidate cache entries when knowledge or policy contracts change.

### 5. LLM Memory & Sessions (HIGH)
- `llm-set-session-ttl-and-window` - Enforce TTL and sliding windows for conversation memory.
- `llm-summarize-long-conversations` - Summarize old turns to control context growth.

### 6. AI Agent Patterns (MEDIUM-HIGH)
- `agent-persist-agent-state-and-checkpoints` - Persist agent state and step checkpoints.
- `agent-use-streams-for-multi-step-workflows` - Use Redis Streams for tool/task orchestration.
- `agent-resume-from-idempotent-checkpoints` - Resume runs without repeating completed tool calls.

### 7. Embeddings & Models (MEDIUM)
- `embed-standardize-model-per-index` - Keep one embedding model per index.
- `embed-batch-embedding-and-upsert` - Batch embedding generation and upserts.
- `embed-make-ingestion-idempotent` - Use stable chunk IDs and cleanup manifests for repeat ingestion.

### 8. Framework Integration (MEDIUM)
- `integrate-use-redisvl-for-schema-and-queries` - Use RedisVL for index schema and query lifecycle.
- `integrate-use-microsoft-agent-framework` - Use Microsoft Agent Framework with Redis for durable memory and retrieval state.

### 9. Performance Tuning (LOW-MEDIUM)
- `perf-size-for-vector-workloads` - Size AMR memory/CPU for vectors and indexing overhead.
- `perf-pipeline-bulk-ingestion` - Pipeline writes for faster indexing throughput.
- `perf-tune-hnsw-runtime-params` - Tune HNSW runtime parameters for latency/recall targets.

## How to Use the Rule Files

Read individual rule files for detailed explanations and code examples in `rules/`, then use `AGENTS.md` for the fully compiled guide.

## Tips for Effective AI Guidance

- Keep one embedding model configuration per index.
- Store metadata needed for filtering, citations, and tenant isolation.
- Enforce tenant, ACL, and lifecycle filters in Redis retrieval queries.
- Return only fields needed by the downstream prompt or application.
- Version semantic cache keys by model and prompt template.
- Invalidate semantic caches when source knowledge or policy versions change.
- Use `AGENTS.md` when the user needs full expanded examples or references.

## Full Compiled Document

For the complete guide with all rules expanded, use `AGENTS.md`.
