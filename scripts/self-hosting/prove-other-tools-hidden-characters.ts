#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const repo = join(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'other-tools-hidden-')))
const driver = join(scratch, 'driver.ts')
writeFileSync(driver, `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const repo = ${JSON.stringify(repo)}
const { enableConfigs } = await import(join(repo, 'src/utils/config/globalConfig.ts'))
enableConfigs()
const { getInstructionFiles } = await import(join(repo, 'src/services/instructions/engine.ts'))
const { currentHiddenCharacterFindings, hiddenCharacterLine, hiddenCharacterScanCounts } = await import(join(repo, 'src/utils/text/hiddenCharacterFindings.ts'))
const files = await getInstructionFiles()
writeFileSync(process.argv[2]!, JSON.stringify({
  texts: Object.fromEntries(files.map((f: any) => [f.path, f.content])),
  findings: currentHiddenCharacterFindings().map((r: any) => ({ source: r.source, path: r.path, points: r.findings.map((f: any) => f.codePoint), line: hiddenCharacterLine(r) })),
  scanned: hiddenCharacterScanCounts().instruction,
}))
`)

type Finding = { source: string; path: string; points: number[]; line: string }
type Drive = { texts: Record<string, string>; findings: Finding[]; scanned: number }

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const ZERO_WIDTH = String.fromCodePoint(0x200b)
const OVERRIDE = String.fromCodePoint(0x202e)
const layout: Record<string, string> = {
  'AGENTS.md': `Use pnpm${ZERO_WIDTH} here\n`,
  'GEMINI.md': `Run pnpm${ZERO_WIDTH} here\n`,
  '.cursorrules': `A plain${OVERRIDE} rule\n`,
  '.cursor/rules/a-always.mdc': `---\nalwaysApply: true\n---\nAlways${ZERO_WIDTH} this\n`,
  '.cursor/rules/b-scoped.mdc': `---\nglobs: src/**\nalwaysApply: false\n---\nScoped${ZERO_WIDTH} that\n`,
  '.cursor/rules/c-manual.mdc': `---\nalwaysApply: false\n---\nManual${ZERO_WIDTH} other\n`,
}

try {
  const project = join(scratch, 'project')
  for (const [rel, content] of Object.entries(layout)) {
    mkdirSync(dirname(join(project, rel)), { recursive: true })
    writeFileSync(join(project, rel), content)
  }
  const named = join(scratch, 'named')
  mkdirSync(named, { recursive: true })
  writeFileSync(join(named, 'AGENTS.md'), `Keep pnpm${ZERO_WIDTH} here\n`)
  const home = join(scratch, 'config')
  seedFirstRun(home, [project])
  const result = join(scratch, 'result.json')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MERCURY_|CLAUDE_|ANTHROPIC_)/.test(key)))
  const run = spawnSync(process.execPath, ['run', driver, result], {
    cwd: project,
    env: { ...env, HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', COPILOT_CUSTOM_INSTRUCTIONS_DIRS: named },
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (run.status !== 0) throw new Error(`driver exited ${run.status}: ${run.stderr}`)
  const drive = JSON.parse(readFileSync(result, 'utf8')) as Drive
  const found = (rel: string): Finding | undefined => drive.findings.find(f => f.path === join(project, rel))
  const control = found('AGENTS.md')

  console.log('the files of other tools that stand in are scanned as AGENTS.md is')
  check('the control: AGENTS.md is named with its invisible character', control?.source === 'instruction' && control.points.join() === String(0x200b), JSON.stringify(control))
  check('a single-file guide of another tool is named the same way', found('GEMINI.md')?.source === 'instruction' && found('GEMINI.md')?.points.join() === String(0x200b) && found('GEMINI.md')?.line.replace('GEMINI.md', 'AGENTS.md') === control?.line, JSON.stringify(found('GEMINI.md')))
  check('a rule file that stands alone is named with its direction override', found('.cursorrules')?.source === 'instruction' && found('.cursorrules')?.points.join() === String(0x202e), JSON.stringify(found('.cursorrules')))
  check('a rule that always applies is named', found('.cursor/rules/a-always.mdc')?.source === 'instruction' && found('.cursor/rules/a-always.mdc')?.points.join() === String(0x200b), JSON.stringify(found('.cursor/rules/a-always.mdc')))
  check('a scoped rule is named before it attaches, as a scoped rule of Mercury is', found('.cursor/rules/b-scoped.mdc')?.source === 'instruction', JSON.stringify(found('.cursor/rules/b-scoped.mdc')))
  const ofNamed = drive.findings.find(f => f.path === join(named, 'AGENTS.md'))
  check('a file of a folder the Copilot variable names is named the same way', ofNamed?.source === 'instruction' && ofNamed.points.join() === String(0x200b), JSON.stringify(ofNamed))
  check('a manual rule, which is never sent, is not scanned', found('.cursor/rules/c-manual.mdc') === undefined && drive.scanned === 6, `${JSON.stringify(found('.cursor/rules/c-manual.mdc'))} scanned=${drive.scanned}`)

  console.log('they are read as written: nothing is stripped and nothing on disk changes')
  check('the text Mercury loads still carries each character, in AGENTS.md and in the others alike', [join(project, 'AGENTS.md'), join(project, 'GEMINI.md'), join(project, '.cursor/rules/a-always.mdc')].every(path => drive.texts[path]?.includes(ZERO_WIDTH)) && drive.texts[join(project, '.cursorrules')]?.includes(OVERRIDE) === true, JSON.stringify(Object.keys(drive.texts)))
  check('every file is byte-identical after the run', Object.entries(layout).every(([rel, content]) => readFileSync(join(project, rel), 'utf8') === content))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`other-tools-hidden-characters: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
