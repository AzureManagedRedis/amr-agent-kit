/**
 * Configuration for the build tooling
 */

import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Base paths
export const SKILLS_DIR = join(__dirname, '../../..', 'skills')
export const BUILD_DIR = join(__dirname, '..')

// Skill configurations
export interface SkillConfig {
  name: string
  title: string
  description: string
  skillDir: string
  rulesDir: string
  metadataFile: string
  outputFile: string
  sectionMap: Record<string, number>
}

export const SKILLS: Record<string, SkillConfig> = {
  'redis-best-practices': {
    name: 'redis-best-practices',
    title: 'Redis Best Practices',
    description: 'Redis applications',
    skillDir: join(SKILLS_DIR, 'redis-best-practices'),
    rulesDir: join(SKILLS_DIR, 'redis-best-practices/rules'),
    metadataFile: join(SKILLS_DIR, 'redis-best-practices/metadata.json'),
    outputFile: join(SKILLS_DIR, 'redis-best-practices/AGENTS.md'),
    sectionMap: {
      ds: 1,
      key: 2,
      cmd: 3,
      conn: 4,
      cache: 5,
      use: 6,
      msg: 7,
      stack: 8,
      memory: 9,
      resilience: 10,
    },
  },
  'redis-ai-patterns': {
    name: 'redis-ai-patterns',
    title: 'Redis AI Patterns',
    description: 'AI applications using Redis',
    skillDir: join(SKILLS_DIR, 'redis-ai-patterns'),
    rulesDir: join(SKILLS_DIR, 'redis-ai-patterns/rules'),
    metadataFile: join(SKILLS_DIR, 'redis-ai-patterns/metadata.json'),
    outputFile: join(SKILLS_DIR, 'redis-ai-patterns/AGENTS.md'),
    sectionMap: {
      vec: 1,
      search: 2,
      rag: 3,
      semcache: 4,
      llm: 5,
      agent: 6,
      embed: 7,
      integrate: 8,
      perf: 9,
    },
  },
  'azure-infra': {
    name: 'azure-infra',
    title: 'Azure Managed Redis Infrastructure',
    description: 'Azure Managed Redis infrastructure and operations',
    skillDir: join(SKILLS_DIR, 'azure-infra'),
    rulesDir: join(SKILLS_DIR, 'azure-infra/rules'),
    metadataFile: join(SKILLS_DIR, 'azure-infra/metadata.json'),
    outputFile: join(SKILLS_DIR, 'azure-infra/AGENTS.md'),
    sectionMap: {
      provision: 1,
      network: 2,
      security: 3,
      availability: 4,
      geo: 5,
      durability: 6,
      performance: 7,
      observability: 8,
    },
  },
}

// Default skill
export const DEFAULT_SKILL = 'redis-best-practices'

// Legacy exports for backwards compatibility
export const SKILL_DIR = SKILLS[DEFAULT_SKILL].skillDir
export const RULES_DIR = SKILLS[DEFAULT_SKILL].rulesDir
export const METADATA_FILE = SKILLS[DEFAULT_SKILL].metadataFile
export const OUTPUT_FILE = SKILLS[DEFAULT_SKILL].outputFile
