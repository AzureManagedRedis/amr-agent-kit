# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, Cursor, Copilot, etc.) when working with code in this repository.

## Repository Overview

A collection of skills for AI coding agents working with Redis and Azure Managed Redis. Skills are packaged instructions and scripts that extend agent capabilities.

## Creating a New Skill

### Directory Structure

```
skills/
  {skill-name}/           # kebab-case directory name
    SKILL.md              # Required: skill definition
    AGENTS.md             # Required: compiled rules (generated)
    metadata.json         # Required: version and metadata
    README.md             # Required: documentation
    rules/                # Required for rule-based skills
      _sections.md        # Section metadata
      _template.md        # Template for new rules
      {prefix}-{name}.md  # Individual rule files
```

### Naming Conventions

- **Skill directory**: `kebab-case`
- **SKILL.md**: Always uppercase, exact filename
- **AGENTS.md**: Always uppercase, exact filename
- **Rule files**: `prefix-description.md`

### Prefixes by Skill

**redis-code:**
`ds-`, `key-`, `cmd-`, `conn-`, `cache-`, `use-`, `msg-`, `stack-`, `memory-`, `resilience-`, `vec-`, `search-`, `rag-`, `semcache-`, `llm-`, `agent-`, `embed-`, `integrate-`, `perf-`

**azure-redis-infra:**
`provision-`, `network-`, `security-`, `availability-`, `geo-`, `durability-`, `performance-`, `observability-`

### SKILL.md Format

```markdown
---
name: {skill-name}
description: {One sentence describing when to use this skill. Include trigger phrases.}
license: MIT
metadata:
  author: Microsoft
  version: "1.0.0"
---

# {Skill Title}

{Brief description of what the skill does.}

## When to Apply

{List of scenarios when this skill should be used}

## Rule Categories by Priority

{Table showing categories and their impact levels}

## Quick Reference

{Organized list of all rules by category}
```

### Best Practices for Context Efficiency

Skills are loaded on-demand. To minimize context usage:

- Keep `SKILL.md` concise (summary + quick reference)
- Put long-form detail in `AGENTS.md` and rule files
- Use precise skill descriptions for accurate activation

## Output

Build compiles individual rules into `AGENTS.md`.

```bash
cd packages/amr-agent-skills-build
npm run build
```

## Troubleshooting

### Build Issues

- Ensure each rule file has valid frontmatter (`title`, `impact`, `tags`)
- Ensure rule prefix matches a configured section prefix
- Ensure `metadata.json` exists and is valid JSON

### Creating a Zip Package

```bash
cd skills
zip -r redis-code.zip redis-code/
zip -r azure-redis-infra.zip azure-redis-infra/
```

### End-User Installation

**Claude Code:**
```bash
cp -r skills/redis-code ~/.claude/skills/
```

**GitHub Copilot / VS Code:**
```bash
cp -r skills/redis-code ~/.copilot/skills/
```

**Using skills CLI:**
```bash
npx skills add AzureManagedRedis/amr-agent-kit
```
