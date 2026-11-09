# Changelog

All notable user-facing changes to AMR Agent Kit should be recorded here.

Use dated entries for future pull requests. Keep entries short, specific, and grouped by skill or repository surface when possible.

## 2026-11-09

### Added

- Added a GitHub Copilot CLI plugin marketplace catalog (`amr-agent-kit`) with the `amr` plugin, which bundles the `redis-code` and `azure-redis-infra` skills. Install it with `/plugin marketplace add AzureManagedRedis/amr-agent-kit` and `/plugin install amr@amr-agent-kit`.

### Changed

- Changed the GitHub Copilot plugin name in the root `plugin.json` from `amr-agent-kit` to `amr`.

## 2026-06-22

### Added

- Added contribution guidance for AMR Agent Kit rules, skills, validation, and eval tasks.
- Added an initial human-facing documentation surface under `docs/`.
- Added MIT license coverage for the repository.
- Added repository metadata and versioning policy for the AMR Agent Kit bundle, build tooling, plugin manifests, and per-skill metadata.

### Changed

- Consolidated the repository around two focused skills: Redis application/AI coding and Azure Managed Redis infrastructure.
- Expanded the root package metadata for the stable `amr-agent-kit` 1.0.0 identity.
