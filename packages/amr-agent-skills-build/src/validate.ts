#!/usr/bin/env node
/**
 * Validate rule files follow the correct structure
 */

import { readFile, readdir } from 'fs/promises'
import { join } from 'path'
import { Rule } from './types.js'
import { parseRuleFile } from './parser.js'
import { SKILLS, SkillConfig } from './config.js'

const args = process.argv.slice(2)
const skillArg = args.find((arg) => arg.startsWith('--skill='))
const skillFlagIndex = args.indexOf('--skill')
const positionalSkill = args.find((arg) => !arg.startsWith('--'))
const envSkill = process.env.npm_config_skill
const skillName = skillArg
  ? skillArg.split('=')[1]
  : skillFlagIndex >= 0
    ? args[skillFlagIndex + 1]
    : positionalSkill || (envSkill && envSkill !== 'true' ? envSkill : null)

interface ValidationError {
  file: string
  ruleId?: string
  message: string
}

interface RuleInput {
  file: string
  filePath: string
  displayFile: string
  sourceName: string
  rulesDir: string
  sectionMap: Record<string, number>
}

// Cross-tool compatibility budget for the combined AGENTS.md instruction chain.
// Codex has the lowest published relevant bound: project_doc_max_bytes defaults
// to 32 KiB and is configurable. Copilot CLI, Claude Code, and Gemini CLI do not
// currently publish a lower hard limit for this mechanism.
// Source: https://learn.chatgpt.com/docs/agent-configuration/agents-md
const MAX_AGENTS_INSTRUCTION_CHAIN_BYTES = 32 * 1024
// Agent Skills recommends keeping SKILL.md below 5,000 tokens and 500 lines.
// The byte budget is a conservative, tokenizer-independent approximation.
// Source: https://agentskills.io/specification
const MAX_SKILL_BYTES = 24 * 1024
const MAX_SKILL_LINES = 500

async function collectRuleInputs(skillConfig: SkillConfig): Promise<RuleInput[]> {
  const sources =
    skillConfig.ruleSources && skillConfig.ruleSources.length > 0
      ? skillConfig.ruleSources
      : [
          {
            name: skillConfig.name,
            rulesDir: skillConfig.rulesDir,
            sectionMap: skillConfig.sectionMap,
          },
        ]

  const inputs: RuleInput[] = []

  for (const source of sources) {
    let files: string[] = []
    try {
      files = await readdir(source.rulesDir)
    } catch {
      console.log(`  No rules directory found for ${source.name}: ${source.rulesDir}`)
      continue
    }

    inputs.push(
      ...files
        .filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'README.md')
        .sort()
        .map((file) => ({
          file,
          filePath: join(source.rulesDir, file),
          displayFile:
            source.name === skillConfig.name ? `${skillConfig.name}/${file}` : `${skillConfig.name}/${source.name}/${file}`,
          sourceName: source.name,
          rulesDir: source.rulesDir,
          sectionMap: source.sectionMap,
        }))
    )
  }

  return inputs
}

/**
 * Validate a rule
 */
function validateRule(
  rule: Rule,
  file: string,
  skillConfig: SkillConfig
): ValidationError[] {
  const errors: ValidationError[] = []

  // Note: rule.id is auto-generated during build, not required in source files

  if (!Number.isInteger(rule.section) || rule.section <= 0) {
    errors.push({
      file,
      ruleId: rule.id,
      message: `Missing or invalid section. Filename must start with one of: ${Object.keys(
        skillConfig.sectionMap
      ).join(', ')}`,
    })
  }

  if (!rule.title || rule.title.trim().length === 0) {
    errors.push({ file, ruleId: rule.id, message: 'Missing or empty title' })
  }

  if (!rule.explanation || rule.explanation.trim().length === 0) {
    errors.push({ file, ruleId: rule.id, message: 'Missing or empty explanation' })
  }

  if (!rule.examples || rule.examples.length === 0) {
    errors.push({
      file,
      ruleId: rule.id,
      message: 'Missing examples (need at least one bad and one good example)',
    })
  } else {
    // Filter out informational examples (notes, trade-offs, etc.) that don't have code
    const codeExamples = rule.examples.filter(
      (e) => e.code && e.code.trim().length > 0
    )

    const hasBad = codeExamples.some(
      (e) =>
        e.label.toLowerCase().includes('incorrect') ||
        e.label.toLowerCase().includes('wrong') ||
        e.label.toLowerCase().includes('bad')
    )
    const hasGood = codeExamples.some(
      (e) =>
        e.label.toLowerCase().includes('correct') ||
        e.label.toLowerCase().includes('good') ||
        e.label.toLowerCase().includes('usage') ||
        e.label.toLowerCase().includes('implementation') ||
        e.label.toLowerCase().includes('example')
    )

    if (codeExamples.length === 0) {
      errors.push({ file, ruleId: rule.id, message: 'Missing code examples' })
    } else if (!hasBad && !hasGood) {
      errors.push({
        file,
        ruleId: rule.id,
        message: 'Missing bad/incorrect or good/correct examples',
      })
    }
  }

  const validImpacts: Rule['impact'][] = [
    'CRITICAL',
    'HIGH',
    'MEDIUM-HIGH',
    'MEDIUM',
    'LOW-MEDIUM',
    'LOW',
  ]
  if (!validImpacts.includes(rule.impact)) {
    errors.push({
      file,
      ruleId: rule.id,
      message: `Invalid impact level: ${rule.impact}. Must be one of: ${validImpacts.join(
        ', '
      )}`,
    })
  }

  return errors
}

function getSkillsToValidate(): SkillConfig[] {
  if (!skillName) {
    return Object.values(SKILLS)
  }

  const skill = SKILLS[skillName]
  if (!skill) {
    console.error(`Unknown skill: ${skillName}`)
    console.error(`Available skills: ${Object.keys(SKILLS).join(', ')}`)
    process.exit(1)
  }

  return [skill]
}

async function validateSkill(skillConfig: SkillConfig): Promise<{
  errors: ValidationError[]
  ruleCount: number
}> {
  console.log(`\nValidating ${skillConfig.name}...`)
  if (skillConfig.ruleSources && skillConfig.ruleSources.length > 0) {
    console.log(
      `  Rule sources: ${skillConfig.ruleSources
        .map((source) => source.name)
        .join(', ')}`
    )
  } else {
    console.log(`  Rules directory: ${skillConfig.rulesDir}`)
  }

  const ruleInputs = await collectRuleInputs(skillConfig)
  const errors: ValidationError[] = []

  if (ruleInputs.length === 0) {
    errors.push({
      file: `${skillConfig.name}/rules`,
      message: 'No rule files found',
    })
  }

  // Keep only repository-specific rule semantics here; Lychee owns link validation.
  for (const input of ruleInputs) {
    try {
      const { rule } = await parseRuleFile(input.filePath, input.sectionMap)
      errors.push(...validateRule(rule, input.displayFile, skillConfig))
    } catch (error) {
      errors.push({
        file: input.displayFile,
        message: `Failed to parse: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  // Check the index alone because some tools may consume it directly.
  try {
    const agentsContent = await readFile(skillConfig.outputFile, 'utf-8')
    const agentsBytes = Buffer.byteLength(agentsContent, 'utf-8')
    if (agentsBytes > MAX_AGENTS_INSTRUCTION_CHAIN_BYTES) {
      errors.push({
        file: `${skillConfig.name}/AGENTS.md`,
        message: `Generated index is ${agentsBytes} bytes; cross-tool compatibility budget is ${MAX_AGENTS_INSTRUCTION_CHAIN_BYTES} bytes`,
      })
    }

    // Codex combines root and nested AGENTS.md files during instruction discovery.
    const repositoryAgentsPath = join(skillConfig.skillDir, '..', '..', 'AGENTS.md')
    const repositoryAgentsContent = await readFile(repositoryAgentsPath, 'utf-8')
    const repositoryInstructionBytes =
      Buffer.byteLength(repositoryAgentsContent, 'utf-8') + agentsBytes
    if (repositoryInstructionBytes > MAX_AGENTS_INSTRUCTION_CHAIN_BYTES) {
      errors.push({
        file: `${skillConfig.name}/AGENTS.md`,
        message: `Repository and skill AGENTS.md files total ${repositoryInstructionBytes} bytes; cross-tool compatibility budget is ${MAX_AGENTS_INSTRUCTION_CHAIN_BYTES} bytes`,
      })
    }
  } catch (error) {
    errors.push({
      file: `${skillConfig.name}/AGENTS.md`,
      message: `Unable to validate generated index: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  // Keep the always-loaded router compact; detailed content belongs in linked rules.
  try {
    const skillContent = await readFile(join(skillConfig.skillDir, 'SKILL.md'), 'utf-8')
    const skillBytes = Buffer.byteLength(skillContent, 'utf-8')
    const skillLines = skillContent.split(/\r?\n/).length
    if (skillBytes > MAX_SKILL_BYTES) {
      errors.push({
        file: `${skillConfig.name}/SKILL.md`,
        message: `Skill router is ${skillBytes} bytes; maximum is ${MAX_SKILL_BYTES} bytes`,
      })
    }
    if (skillLines > MAX_SKILL_LINES) {
      errors.push({
        file: `${skillConfig.name}/SKILL.md`,
        message: `Skill router has ${skillLines} lines; maximum is ${MAX_SKILL_LINES}`,
      })
    }
  } catch (error) {
    errors.push({
      file: `${skillConfig.name}/SKILL.md`,
      message: `Unable to validate skill router: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  if (errors.length === 0) {
    console.log(`  ✓ ${ruleInputs.length} rule files are valid`)
  }

  return { errors, ruleCount: ruleInputs.length }
}

/**
 * Main validation function
 */
async function validate() {
  try {
    console.log('Validating rule files...')

    const skillsToValidate = getSkillsToValidate()
    const allErrors: ValidationError[] = []
    let totalRuleCount = 0

    for (const skill of skillsToValidate) {
      const { errors, ruleCount } = await validateSkill(skill)
      allErrors.push(...errors)
      totalRuleCount += ruleCount
    }

    if (allErrors.length > 0) {
      console.error('\n✗ Validation failed:\n')
      allErrors.forEach((error) => {
        console.error(
          `  ${error.file}${error.ruleId ? ` (${error.ruleId})` : ''}: ${error.message}`
        )
      })
      process.exit(1)
    }

    console.log(
      `\n✓ All ${totalRuleCount} rule files across ${skillsToValidate.length} skill(s) are valid`
    )
  } catch (error) {
    console.error('Validation failed:', error)
    process.exit(1)
  }
}

validate()
