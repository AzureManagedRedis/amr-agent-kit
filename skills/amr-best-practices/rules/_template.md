# Rollup Rule Template

Do not add copied rule content to this directory for normal maintenance.

The `amr-best-practices` skill is generated from the focused skill rule files:

- `skills/redis-best-practices/rules/`
- `skills/redis-ai-patterns/rules/`
- `skills/azure-infra/rules/`

Add new rules to the appropriate focused skill, update this rollup's `_sections.md` only if a category or ordering change is required, and run:

```bash
npm run build
npm run validate
```

If a future rollup-only rule is intentionally needed, use the focused skill rule format and update the build configuration so ownership is explicit.
