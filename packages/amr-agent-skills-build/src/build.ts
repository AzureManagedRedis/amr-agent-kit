#!/usr/bin/env node
/**
 * Build script to compile individual rule files into AGENTS.md
 */

import { readdir, readFile, writeFile } from 'fs/promises'
import { join, relative } from 'path'
import { Rule, Section, ImpactLevel } from './types.js'
import { parseRuleFile, RuleFile } from './parser.js'
import { SKILLS, SkillConfig, DEFAULT_SKILL } from './config.js'

// Parse command line arguments
const args = process.argv.slice(2)
const upgradeVersion = args.includes('--upgrade-version')
const skillArg = args.find((arg) => arg.startsWith('--skill='))
const skillFlagIndex = args.indexOf('--skill')
const positionalSkill = args.find((arg) => !arg.startsWith('--'))
const envSkill = process.env.npm_config_skill
const skillName = skillArg
  ? skillArg.split('=')[1]
  : skillFlagIndex >= 0
    ? args[skillFlagIndex + 1]
    : positionalSkill || (envSkill && envSkill !== 'true' ? envSkill : null)
const buildAll = args.includes('--all')


/**
 * Write text only when content changes, preserving an existing file's line endings.
 */
async function writeTextFileIfChanged(
  filePath: string,
  content: string
): Promise<boolean> {
  let existing: string | null = null
  let lineEnding = '\n'

  try {
    existing = await readFile(filePath, 'utf-8')
    lineEnding = existing.includes('\r\n') ? '\r\n' : '\n'
  } catch {
    // File does not exist yet; default to LF for generated content.
  }

  const normalizedContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const nextContent =
    lineEnding === '\n'
      ? normalizedContent
      : normalizedContent.replace(/\n/g, lineEnding)

  if (existing === nextContent) {
    return false
  }

  await writeFile(filePath, nextContent, 'utf-8')
  return true
}

/**
 * Increment a semver-style version string (e.g., "0.1.0" -> "0.1.1", "1.0" -> "1.1")
 */
function incrementVersion(version: string): string {
  const parts = version.split('.').map(Number)
  // Increment the last part
  parts[parts.length - 1]++
  return parts.join('.')
}

/**
 * Generate a compact rule index for progressive disclosure.
 */
function generateMarkdown(
  sections: Section[],
  metadata: {
    version: string
    organization: string
    date: string
    abstract: string
    references?: string[]
  },
  skillConfig: SkillConfig
): string {
  let md = `# ${skillConfig.title} Rule Index\n\n`
  md += `**Version ${metadata.version}**  \n`
  md += `${metadata.organization}  \n`
  md += `${metadata.date}\n\n`
  md += `${metadata.abstract}\n\n`
  md += `This generated file is a compact catalog, not a complete instruction bundle. Start with [SKILL.md](SKILL.md), select only the categories relevant to the task, and then read the linked source rules under \`rules/\`. Do not load every rule unless the task genuinely spans the full skill.\n\n`

  sections.forEach((section) => {
    md += `## ${section.number}. ${section.title}\n\n`
    md += `**Category impact: ${section.impact}**\n\n`

    section.rules.forEach((rule) => {
      const sourceFile = rule.sourceFile || 'rules/'
      md += `- **${rule.id}** [${rule.title}](${sourceFile}) — ${rule.impact}\n`
    })

    md += '\n'
  })

  if (metadata.references && metadata.references.length > 0) {
    md += `## Product References\n\n`
    metadata.references.forEach((ref, i) => {
      md += `${i + 1}. [${ref}](${ref})\n`
    })
  }

  return md
}

interface RuleInput {
  file: string
  filePath: string
  displayFile: string
  sourceName: string
  rulesDir: string
  sectionMap: Record<string, number>
}

interface ParsedRuleInput {
  input: RuleInput
  parsed: RuleFile
}

async function readSkillMetadata(skillConfig: SkillConfig) {
  try {
    const metadataContent = await readFile(skillConfig.metadataFile, 'utf-8')
    return JSON.parse(metadataContent)
  } catch {
    return {
      version: '1.0.0',
      organization: 'Microsoft',
      date: new Date().toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
      }),
      abstract: `Performance optimization guide for ${skillConfig.description}, ordered by impact.`,
    }
  }
}

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
            source.name === skillConfig.name ? file : `${source.name}/${file}`,
          sourceName: source.name,
          rulesDir: source.rulesDir,
          sectionMap: source.sectionMap,
        }))
    )
  }

  return inputs
}

async function writeRuleManifestIfConfigured(
  skillConfig: SkillConfig,
  ruleInputs: RuleInput[],
  parsedRuleInputs: ParsedRuleInput[]
): Promise<void> {
  if (!skillConfig.manifestFile) {
    return
  }

  const toSkillRelativePath = (path: string) =>
    relative(skillConfig.skillDir, path).replace(/\\/g, '/')

  const sourceNames = Array.from(new Set(ruleInputs.map((input) => input.sourceName)))
  const sources = sourceNames.map((sourceName) => {
    const sourceInputs = ruleInputs.filter((input) => input.sourceName === sourceName)
    const parsedForSource = parsedRuleInputs.filter(
      ({ input }) => input.sourceName === sourceName
    )
    const sections = Array.from(
      new Set(parsedForSource.map(({ parsed }) => parsed.section))
    ).sort((a, b) => a - b)

    return {
      skill: sourceName,
      rulesDir: toSkillRelativePath(sourceInputs[0].rulesDir),
      ruleCount: sourceInputs.length,
      sections,
    }
  })

  const manifest = {
    generatedBy: 'packages/amr-agent-skills-build/src/build.ts',
    description:
      'Deterministic rule manifest. Rule content is sourced from configured rule files and is not copied into this manifest.',
    skill: skillConfig.name,
    totalRules: parsedRuleInputs.length,
    sources,
    rules: parsedRuleInputs
      .map(({ input, parsed }) => ({
        sourceSkill: input.sourceName,
        sourceFile: toSkillRelativePath(input.filePath),
        section: parsed.section,
        title: parsed.rule.title,
      }))
      .sort((a, b) =>
        `${a.section}:${a.sourceSkill}:${a.sourceFile}`.localeCompare(
          `${b.section}:${b.sourceSkill}:${b.sourceFile}`,
          'en-US',
          { sensitivity: 'base' }
        )
      ),
  }

  await writeTextFileIfChanged(
    skillConfig.manifestFile,
    JSON.stringify(manifest, null, 2) + '\n'
  )
  console.log(`  ✓ Wrote rule source manifest`)
}

/**
 * Build a single skill
 */
async function buildSkill(skillConfig: SkillConfig) {
  console.log(`\nBuilding ${skillConfig.name}...`)
  if (skillConfig.ruleSources && skillConfig.ruleSources.length > 0) {
    console.log(
      `  Rule sources: ${skillConfig.ruleSources
        .map((source) => source.name)
        .join(', ')}`
    )
  } else {
    console.log(`  Rules directory: ${skillConfig.rulesDir}`)
  }
  console.log(`  Output file: ${skillConfig.outputFile}`)

  const ruleInputs = await collectRuleInputs(skillConfig)

  if (ruleInputs.length === 0) {
    throw new Error(`No rule files found for ${skillConfig.name}`)
  }

  const ruleData: RuleFile[] = []
  const parsedRuleInputs: ParsedRuleInput[] = []
  for (const input of ruleInputs) {
    const parsed = await parseRuleFile(input.filePath, input.sectionMap)
    parsed.rule.sourceFile = relative(skillConfig.skillDir, input.filePath).replace(
      /\\/g,
      '/'
    )
    ruleData.push(parsed)
    parsedRuleInputs.push({ input, parsed })
  }
  await writeRuleManifestIfConfigured(skillConfig, ruleInputs, parsedRuleInputs)

  // Group rules by section
  const sectionsMap = new Map<number, Section>()

  ruleData.forEach(({ section, rule }) => {
    if (!sectionsMap.has(section)) {
      sectionsMap.set(section, {
        number: section,
        title: `Section ${section}`, // Will be overridden by section metadata
        impact: rule.impact,
        rules: [],
      })
    }
    sectionsMap.get(section)!.rules.push(rule)
  })

  // Sort rules within each section by title (using en-US locale for consistency across environments)
  sectionsMap.forEach((section) => {
    section.rules.sort((a, b) =>
      a.title.localeCompare(b.title, 'en-US', { sensitivity: 'base' })
    )

    // Assign IDs based on sorted order
    section.rules.forEach((rule, index) => {
      rule.id = `${section.number}.${index + 1}`
      rule.subsection = index + 1
    })
  })

  // Convert to array and sort
  const sections = Array.from(sectionsMap.values()).sort(
    (a, b) => a.number - b.number
  )

  // Read section metadata from consolidated _sections.md file
  const sectionsFile = join(skillConfig.rulesDir, '_sections.md')
  try {
    const sectionsContent = await readFile(sectionsFile, 'utf-8')

    // Parse sections using regex to match each section block
    const sectionBlocks = sectionsContent
      .split(/(?=^## \d+\. )/m)
      .filter(Boolean)

    for (const block of sectionBlocks) {
      // Extract section number and title, removing section ID in parentheses
      const headerMatch = block.match(/^## (\d+)\.\s+(.+?)(?:\s+\([^)]+\))?$/m)
      if (!headerMatch) continue

      const sectionNumber = parseInt(headerMatch[1])
      const sectionTitle = headerMatch[2].trim() // Strip (id) for output

      // Extract impact (format: **Impact:** CRITICAL)
      const impactMatch = block.match(/\*\*Impact:\*\*\s+(\w+(?:-\w+)?)/i)
      const impactLevel = impactMatch
        ? (impactMatch[1].toUpperCase().replace(/-/g, '-') as ImpactLevel)
        : 'MEDIUM'

      // Extract description (format: **Description:** text)
      const descMatch = block.match(/\*\*Description:\*\*\s+(.+?)(?=\n\n##|$)/s)
      const description = descMatch ? descMatch[1].trim() : ''

      // Update section if it exists
      const section = sections.find((s) => s.number === sectionNumber)
      if (section) {
        section.title = sectionTitle
        section.impact = impactLevel
        section.introduction = description
      }
    }
  } catch (error) {
    console.warn('  Warning: Could not read _sections.md, using defaults')
  }

  const metadata = await readSkillMetadata(skillConfig)

  // Upgrade version if flag is passed
  if (upgradeVersion) {
    const oldVersion = metadata.version
    metadata.version = incrementVersion(oldVersion)
    console.log(`  Upgrading version: ${oldVersion} -> ${metadata.version}`)

    // Write updated metadata.json
    await writeTextFileIfChanged(
      skillConfig.metadataFile,
      JSON.stringify(metadata, null, 2) + '\n'
    )
    console.log(`  ✓ Updated metadata.json`)

    // Update SKILL.md frontmatter if it exists
    const skillFile = join(skillConfig.skillDir, 'SKILL.md')
    try {
      const skillContent = await readFile(skillFile, 'utf-8')
      const updatedSkillContent = skillContent.replace(
        /^(---[\s\S]*?version:\s*)"[^"]*"([\s\S]*?---)$/m,
        `$1"${metadata.version}"$2`
      )
      await writeTextFileIfChanged(skillFile, updatedSkillContent)
      console.log(`  ✓ Updated SKILL.md`)
    } catch {
      // SKILL.md doesn't exist, skip
    }
  }

  // Generate markdown
  const markdown = generateMarkdown(sections, metadata, skillConfig)

  // Write output
  await writeTextFileIfChanged(skillConfig.outputFile, markdown)

  console.log(
    `  ✓ Built compact AGENTS.md index with ${sections.length} sections and ${ruleData.length} rule links`
  )
}

/**
 * Main build function
 */
async function build() {
  try {
    console.log('Building AGENTS.md from rules...')

    if (buildAll) {
      // Build all skills
      for (const skill of Object.values(SKILLS)) {
        await buildSkill(skill)
      }
    } else if (skillName) {
      // Build specific skill
      const skill = SKILLS[skillName]
      if (!skill) {
        console.error(`Unknown skill: ${skillName}`)
        console.error(`Available skills: ${Object.keys(SKILLS).join(', ')}`)
        process.exit(1)
      }
      await buildSkill(skill)
    } else {
      // Build default skill (backwards compatibility)
      await buildSkill(SKILLS[DEFAULT_SKILL])
    }

    console.log('\n✓ Build complete')
  } catch (error) {
    console.error('Build failed:', error)
    process.exit(1)
  }
}

build()
