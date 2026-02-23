---
name: redis-ai-patterns
description: Patterns for building AI applications with Redis, optimized for Azure Managed Redis (Redis Enterprise 7.4). Use when implementing vector search, RAG, semantic caching, LLM memory, or AI agents on AMR. Triggers on tasks involving embeddings, similarity search, retrieval augmented generation, LangChain, LlamaIndex, or vector databases on Azure.
license: MIT
metadata:
  author: Microsoft
  version: "1.0.0"
---

# Redis AI Patterns

Patterns and best practices for building AI and ML applications with Redis on Azure Managed Redis. Covers vector search, RAG implementation, semantic caching, LLM integration, and agent state patterns tuned for AMR and Redis Enterprise 7.4 capabilities.

## When to Apply

Reference these guidelines when:
- Storing and querying vector embeddings
- Building RAG (Retrieval Augmented Generation) pipelines
- Implementing semantic caching for LLM responses
- Managing conversation history and LLM memory
- Building AI agents with Redis as the memory layer
- Integrating with LangChain, LlamaIndex, Semantic Kernel, RedisVL, or Microsoft Agent Framework

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

### 3. RAG Implementation (HIGH)
- `rag-chunk-content-with-stable-windowing` - Chunk documents consistently with overlap.
- `rag-store-source-citations-in-index` - Store source metadata for grounding and citations.

### 4. Semantic Caching (HIGH)
- `semcache-set-threshold-and-ttl-by-use-case` - Tune semantic threshold and TTL by workload.
- `semcache-version-keys-by-model-and-prompt` - Version cache keys by model and prompt template.

### 5. LLM Memory & Sessions (HIGH)
- `llm-set-session-ttl-and-window` - Enforce TTL and sliding windows for conversation memory.
- `llm-summarize-long-conversations` - Summarize old turns to control context growth.

### 6. AI Agent Patterns (MEDIUM-HIGH)
- `agent-persist-agent-state-and-checkpoints` - Persist agent state and step checkpoints.
- `agent-use-streams-for-multi-step-workflows` - Use Redis Streams for tool/task orchestration.

### 7. Embeddings & Models (MEDIUM)
- `embed-standardize-model-per-index` - Keep one embedding model per index.
- `embed-batch-embedding-and-upsert` - Batch embedding generation and upserts.

### 8. Framework Integration (MEDIUM)
- `integrate-use-redisvl-for-schema-and-queries` - Use RedisVL for index schema and query lifecycle.
- `integrate-use-microsoft-agent-framework` - Use Microsoft Agent Framework with Redis for durable memory and retrieval state.

### 9. Performance Tuning (LOW-MEDIUM)
- `perf-size-for-vector-workloads` - Size AMR memory/CPU for vectors and indexing overhead.
- `perf-pipeline-bulk-ingestion` - Pipeline writes for faster indexing throughput.
- `perf-tune-hnsw-runtime-params` - Tune HNSW runtime parameters for latency/recall targets.

## How to Use

Read individual rule files for detailed explanations and code examples in `rules/`, then use `AGENTS.md` for the fully compiled guide.

## Full Compiled Document

For the complete guide with all rules expanded: `AGENTS.md`
