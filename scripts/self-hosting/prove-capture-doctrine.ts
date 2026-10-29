#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const repo = join(import.meta.dir, '..', '..')

let failures = 0
const check = (cond: boolean, msg: string, detail = ''): void => {
  if (cond) console.log(`  [PASS] ${msg}`)
  else {
    failures++
    console.error(`  [FAIL] ${msg}${detail ? ` — ${detail}` : ''}`)
  }
}

const driverSrc = `
import { enableConfigs } from '${repo}/src/utils/config/globalConfig.js'
enableConfigs()
const { getSystemPrompt } = await import('${repo}/src/constants/prompts.js')
const withTools = process.argv[process.argv.length - 1] === 'with-tools'
const tools = withTools
  ? [{ name: 'RecordConvention' }, { name: 'Retain' }, { name: 'Bash' }]
  : [{ name: 'Bash' }]
const sections = await getSystemPrompt(tools, 'claude-fable-5')
console.log(JSON.stringify({ prompt: sections.join('\\n\\n') }))
`
const driverDir = mkdtempSync(join(tmpdir(), 'doctrine-drv-'))
const driverPath = join(driverDir, 'drv.ts')
writeFileSync(driverPath, driverSrc)

function drive(variant: 'with-tools' | 'bare'): string {
  const home = mkdtempSync(join(tmpdir(), 'doctrine-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'doctrine-cwd-'))
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(MERCURY_|CLAUDE_)/.test(k)) continue
    env[k] = v
  }
  env.MERCURY_CONFIG_DIR = home
  env.MERCURY_EVOLUTION_LEDGER = '0'
  const run = spawnSync(process.execPath, ['run', driverPath, variant], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  })
  rmSync(home, { recursive: true, force: true })
  if (run.status !== 0) {
    console.error(`  [FAIL] driver exited ${run.status}: ${String(run.stderr).slice(0, 800)}`)
    process.exit(1)
  }
  const lines = String(run.stdout).trim().split('\n')
  return (JSON.parse(lines[lines.length - 1]!) as { prompt: string }).prompt
}

console.log('assembled prompt — tools on the roster')
const prompt = drive('with-tools')
check(prompt.includes('# The project estate'), 'the estate section is present')
check(
  prompt.includes("MERCURY.md is the project's standing instruction file: Mercury loads it every session, together with whatever it explicitly @imports."),
  'the instruction file fact: MERCURY.md, loaded every session with its @imports',
)
check(
  prompt.includes('Durable project-local plans and working specs that the user requests live in `.mercury/`. Mercury keeps the handoff note it asks for at close in its own home; never write your own handoff file into the project.'),
  'the .mercury working-state fact',
)
check(
  prompt.includes('belongs to the instruction estate; the RecordConvention tool writes it there, follows an @import pointer to the guide it names, and refines an existing rule through its `replaces` field in place of a near-copy'),
  'the convention door, tool-spelled: the pointer and the replaces field as facts of the tool',
)
check(
  prompt.includes('A rule the user asks you to remember about working with them is pinned memory instead (Retain with pin): kept in their words, loaded into every session, never written into the instruction file.'),
  'the pinned door, tool-spelled when Retain rides the roster',
)
check(
  prompt.includes("Hooks are shell commands the user set up in settings to run on events such as tool calls; what a hook prints, the prompt-submit hook's included, is the user's own feedback, and a hook that blocks an action says why there."),
  'the hooks fact',
)

console.log('assembled prompt — the doctrine prose is gone: facts only, stated once')
const once = (needle: string): boolean => prompt.split(needle).length === 2
check(once('# The project estate') && once('MERCURY.md is the project'), 'the estate facts ride exactly once')
check(
  ['and say you did', 'No magic word', 'One-off task details are never enshrined', 'Merge, never duplicate', 'Name the choice when you record', 'curated context, not a log', 'never stacked into the pointer file', "checked in or gitignored is the user's call", 'binds everyone who works in this project'].every(words => !prompt.includes(words)),
  'none of the old doctrine sentences survive',
)
check(
  ['Skip preambles for quick tasks', 'Announce your intent before the first tool call', 'Avoid introducing security vulnerabilities', 'Fix security issues within the authorised implementation scope', 'Claim only what a tool result from this session shows', 'no re-verifying what was already checked', 'Report faithfully'].every(words => !prompt.includes(words)),
  'the narration, security and evidence prose is gone with the rest',
)
check(!prompt.includes('states a durable project instruction, correction, or convention'), 'no sentence routes every standing instruction to the instruction file')

console.log('assembled prompt — bare roster (the facts hold without tool spellings)')
const bare = drive('bare')
check(bare.includes('# The project estate'), 'section present without the tools')
const bareEstate = bare.slice(bare.indexOf('# The project estate'), bare.indexOf('\n# ', bare.indexOf('# The project estate') + 1))
check(!bare.includes('RecordConvention') && !bareEstate.includes('Retain'), 'no phantom tool name on a bare roster (the memory section names its own verbs)')
check(
  bareEstate.includes('belongs to the instruction estate. A rule the user asks you to remember about working with them is pinned memory instead: kept in their words, loaded into every session, never written into the instruction file.'),
  'the two doors stand on a bare roster without a tool spelling',
)
check(
  bareEstate.includes("MERCURY.md is the project's standing instruction file") && bareEstate.includes('live in `.mercury/`') && bareEstate.includes('Hooks are shell commands'),
  'the instruction-file, working-state and hooks facts read the same on a bare roster',
)

console.log(failures === 0 ? '\nFACTS PINNED' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
