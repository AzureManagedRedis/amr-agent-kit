#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const defaultEvalFile = path.join(repoRoot, 'evals', 'efficacy', 'evals.json')

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function parseArgs(args) {
  const options = {
    evalFile: defaultEvalFile,
    out: path.join(repoRoot, 'eval-runs', 'amr-agent-kit-efficacy', `iteration-${timestamp()}`),
    runs: 1,
  }
  const positional = []

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--eval-file') {
      options.evalFile = path.resolve(args[++i])
    } else if (arg === '--out') {
      options.out = path.resolve(args[++i])
    } else if (arg === '--runs') {
      options.runs = Number.parseInt(args[++i], 10)
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (!arg.startsWith('-')) {
      positional.push(arg)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (positional[0]) {
    options.out = path.resolve(positional[0])
  }
  if (positional[1]) {
    options.runs = Number.parseInt(positional[1], 10)
  }

  if (!Number.isInteger(options.runs) || options.runs <= 0) {
    throw new Error('--runs must be a positive integer')
  }

  return options
}

function printHelp() {
  console.log(`Prepare a paired efficacy-eval workspace.

Usage:
  node scripts/prepare-efficacy-workspace.mjs [--out <dir>] [--eval-file <file>] [--runs <n>]
  node scripts/prepare-efficacy-workspace.mjs <dir> [runs]

The workspace follows the skill-creator layout expected by:
  python -m scripts.aggregate_benchmark <workspace> --skill-name amr-agent-kit
  python <skill-creator>/eval-viewer/generate_review.py <workspace> --static <file>
`)
}

function buildWithSkillPrompt(evalCase) {
  return `Execute this AMR Agent Kit efficacy eval with the target skill force-loaded.

Skill path: ${evalCase.skill_path}
Task:
${evalCase.prompt}

Before answering, read the compact rule index above, the adjacent SKILL.md, and only the linked rule files relevant to the task. Apply that guidance and save the final answer to outputs/answer.md.

The answer should be concise but complete enough for grading. Do not mention that this is an eval unless it helps explain assumptions.`
}

function buildWithoutSkillPrompt(evalCase) {
  return `Execute this AMR Agent Kit efficacy baseline eval without loading any AMR Agent Kit skill files.

Task:
${evalCase.prompt}

Do not read files under skills/ for this run. Use only your general knowledge. Save the final answer to outputs/answer.md.

The answer should be concise but complete enough for grading. Do not mention that this is an eval unless it helps explain assumptions.`
}

function buildReadme(evals, runs) {
  return `# AMR Agent Kit Efficacy Workspace

This workspace was generated from \`evals/efficacy/evals.json\`.

For each eval, run both configurations with the same model:

1. \`with_skill\` - use the prompt in \`with_skill/run-N/run_prompt.md\`.
2. \`without_skill\` - use the prompt in \`without_skill/run-N/run_prompt.md\`.

Save each final answer to that run's \`outputs/answer.md\`, then grade against the expectations in \`eval_metadata.json\` and save \`grading.json\` beside \`outputs/\`.

After grading:

\`\`\`bash
python -m scripts.aggregate_benchmark <this-workspace> --skill-name amr-agent-kit
python <skill-creator-path>/eval-viewer/generate_review.py <this-workspace> --skill-name "AMR Agent Kit" --benchmark <this-workspace>/benchmark.json --static <this-workspace>/review.html
\`\`\`

Generated evals: ${evals.length}
Runs per configuration: ${runs}
`
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (!existsSync(options.evalFile)) {
    throw new Error(`Eval file not found: ${options.evalFile}`)
  }

  const evalConfig = JSON.parse(await readFile(options.evalFile, 'utf8'))
  const evals = evalConfig.evals ?? []
  if (!Array.isArray(evals) || evals.length === 0) {
    throw new Error(`No evals found in ${options.evalFile}`)
  }

  await mkdir(options.out, { recursive: true })
  await writeFile(path.join(options.out, 'README.md'), buildReadme(evals, options.runs), 'utf8')

  for (const evalCase of evals) {
    const evalDir = path.join(
      options.out,
      `eval-${evalCase.id}-${slugify(evalCase.name ?? `case-${evalCase.id}`)}`
    )

    await mkdir(evalDir, { recursive: true })
    await writeJson(path.join(evalDir, 'eval_metadata.json'), {
      eval_id: evalCase.id,
      eval_name: evalCase.name,
      target_skill: evalCase.target_skill,
      skill_path: evalCase.skill_path,
      prompt: evalCase.prompt,
      expected_output: evalCase.expected_output,
      assertions: evalCase.expectations,
      anti_patterns: evalCase.anti_patterns,
      minimum_skill_score: evalCase.minimum_skill_score,
      minimum_uplift: evalCase.minimum_uplift,
    })

    for (const configuration of ['with_skill', 'without_skill']) {
      for (let run = 1; run <= options.runs; run += 1) {
        const runDir = path.join(evalDir, configuration, `run-${run}`)
        const outputsDir = path.join(runDir, 'outputs')
        await mkdir(outputsDir, { recursive: true })
        const prompt =
          configuration === 'with_skill'
            ? buildWithSkillPrompt(evalCase)
            : buildWithoutSkillPrompt(evalCase)
        await writeFile(path.join(runDir, 'run_prompt.md'), prompt, 'utf8')
      }
    }
  }

  console.log(`Prepared efficacy workspace: ${options.out}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
