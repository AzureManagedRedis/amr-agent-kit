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
  ruleSources?: RuleSourceConfig[]
  manifestFile?: string
}

export interface RuleSourceConfig {
  name: string
  rulesDir: string
  sectionMap: Record<string, number>
}

const redisCodeSectionMap = {
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
  vec: 11,
  search: 12,
  rag: 13,
  semcache: 14,
  llm: 15,
  agent: 16,
  embed: 17,
  integrate: 18,
  perf: 19,
}

const azureRedisInfraSectionMap = {
  provision: 1,
  network: 2,
  security: 3,
  availability: 4,
  geo: 5,
  durability: 6,
  performance: 7,
  observability: 8,
}

export const SKILLS: Record<string, SkillConfig> = {
  'redis-code': {
    name: 'redis-code',
    title: 'Redis Code Best Practices',
    description: 'Redis application, caching, vector search, RAG, semantic caching, and agent patterns',
    skillDir: join(SKILLS_DIR, 'redis-code'),
    rulesDir: join(SKILLS_DIR, 'redis-code/rules'),
    metadataFile: join(SKILLS_DIR, 'redis-code/metadata.json'),
    outputFile: join(SKILLS_DIR, 'redis-code/AGENTS.md'),
    sectionMap: redisCodeSectionMap,
  },
  'azure-redis-infra': {
    name: 'azure-redis-infra',
    title: 'Azure Managed Redis Infrastructure',
    description: 'Azure Managed Redis infrastructure and operations',
    skillDir: join(SKILLS_DIR, 'azure-redis-infra'),
    rulesDir: join(SKILLS_DIR, 'azure-redis-infra/rules'),
    metadataFile: join(SKILLS_DIR, 'azure-redis-infra/metadata.json'),
    outputFile: join(SKILLS_DIR, 'azure-redis-infra/AGENTS.md'),
    sectionMap: azureRedisInfraSectionMap,
  },
}

// Default skill
export const DEFAULT_SKILL = 'redis-code'

// Legacy exports for backwards compatibility
export const SKILL_DIR = SKILLS[DEFAULT_SKILL].skillDir
export const RULES_DIR = SKILLS[DEFAULT_SKILL].rulesDir
export const METADATA_FILE = SKILLS[DEFAULT_SKILL].metadataFile
export const OUTPUT_FILE = SKILLS[DEFAULT_SKILL].outputFile
