# AMR Best Practices

Monolithic AMR Agent Kit rollup skill for comprehensive Redis and Azure Managed Redis guidance.

Use this skill when a task spans multiple domains:

- Redis application development and production code patterns
- Redis AI, vector search, RAG, semantic caching, LLM memory, and agent state
- Azure Managed Redis provisioning, security, networking, availability, durability, performance, and observability

For narrow single-domain tasks, prefer the focused skills:

- `redis-best-practices`
- `redis-ai-patterns`
- `azure-infra`

## Generated Source Model

This skill does not maintain copied rule files. The source of truth remains the focused skill rule directories:

```text
skills/redis-best-practices/rules/
skills/redis-ai-patterns/rules/
skills/azure-infra/rules/
```

The build tool reads those rules through the `amr-best-practices` configuration in `packages/amr-agent-skills-build/src/config.ts`, then generates:

- `AGENTS.md` - consolidated long-form guidance
- `rules.manifest.json` - deterministic source manifest with rule counts and source files

The rollup-local `rules/` directory contains category metadata only.

## Build and Validate

From the repository root:

```bash
npm run build
npm run validate
```

Or from the build package:

```bash
cd packages/amr-agent-skills-build
npm run build-amr-best-practices
npm run validate -- --skill=amr-best-practices
```

## Maintenance

1. Add or update rule content in the appropriate focused skill.
2. Update `skills/amr-best-practices/rules/_sections.md` only when rollup category names, ordering, or descriptions need to change.
3. Run `npm run build` to regenerate `AGENTS.md` and `rules.manifest.json`.
4. Run `npm run validate` before opening a pull request.

## Files

- `SKILL.md` - activation and agent-facing guidance.
- `README.md` - human-facing usage and maintenance notes.
- `metadata.json` - version, abstract, and reference links.
- `AGENTS.md` - generated consolidated guide with all 76 current rules.
- `rules.manifest.json` - generated source manifest.
- `rules/_sections.md` - rollup category metadata.
- `rules/_template.md` - maintenance guardrail for future rollup changes.
