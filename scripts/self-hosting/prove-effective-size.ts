#!/usr/bin/env bun
import { execSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const repo = join(import.meta.dir, '..', '..')

let failures = 0
const check = (cond: boolean, msg: string, detail = ''): void => {
  if (cond) console.log(`  [PASS] ${msg}`)
  else {
    failures++
    console.error(`  [FAIL] ${msg}${detail ? ` — ${detail}` : ''}`)
  }
}

const { measureEffectiveProjectInstructionLines, measuredGuideName, PROJECT_INSTRUCTION_TRIM_LINE_THRESHOLD } =
  await import(`${repo}/src/services/instructions/effectiveSize.js`)

console.log('the threshold is the ruled bar')
check(PROJECT_INSTRUCTION_TRIM_LINE_THRESHOLD === 400, 'threshold = 400 effective lines')

console.log('scope: project estate only')
const mk = (path: string, type: string, lines: number, parent?: string) => ({
  path,
  type,
  content: Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n'),
  ...(parent === undefined ? {} : { parent }),
})
check(
  measureEffectiveProjectInstructionLines([
    mk('/p/MERCURY.md', 'Project', 3),
    mk('/p/AGENTS.md', 'Project', 600, '/p/MERCURY.md'),
  ] as never) === 603,
  'entry + import = 603 (the pointer costs what it pulls in)',
)
check(
  measureEffectiveProjectInstructionLines([
    mk('/home/.mercury/MERCURY.md', 'User', 500),
    mk('/p/.mercury/rules/style.md', 'Project', 500),
    mk('/p/MERCURY.local.md', 'Local', 7),
  ] as never) === 7,
  'user scope and rules files stay outside; MERCURY.local.md counts',
)

console.log('the guide the measure names')
const guideOf: (files: unknown) => string = typeof measuredGuideName === 'function' ? measuredGuideName : () => 'MERCURY.md'
check(guideOf([mk('/p/MERCURY.md', 'Project', 3), mk('/p/AGENTS.md', 'Project', 600, '/p/MERCURY.md')]) === 'MERCURY.md', 'a MERCURY.md pointer at AGENTS.md: the guide is MERCURY.md')
check(guideOf([mk('/p/AGENTS.md', 'Project', 600)]) === 'AGENTS.md', 'an AGENTS.md-only estate: the guide is AGENTS.md')
check(guideOf([mk('/home/.mercury/MERCURY.md', 'User', 500), mk('/p/MERCURY.local.md', 'Local', 7)]) === 'MERCURY.local.md', 'a local-only estate names the local file: it is all that loads')
check(guideOf([mk('/p/MERCURY.local.md', 'Local', 7), mk('/p/AGENTS.md', 'Project', 600)]) === 'AGENTS.md', 'a personal layer beside an AGENTS.md guide: the guide is AGENTS.md')

const driverSrc = `
import { enableConfigs } from '${repo}/src/utils/config/globalConfig.js'
enableConfigs()
const { getInstructionFiles } = await import('${repo}/src/services/instructions/engine.js')
const { measureEffectiveProjectInstructionLines, measuredGuideName, PROJECT_INSTRUCTION_TRIM_LINE_THRESHOLD } =
  await import('${repo}/src/services/instructions/effectiveSize.js')
const chip = await import('${repo}/src/components/mercury-ui/TrimChip.js')
const files = await getInstructionFiles()
const lines = measureEffectiveProjectInstructionLines(files)
const guide = typeof measuredGuideName === 'function' ? measuredGuideName(files) : 'MERCURY.md'
const text = typeof chip.trimChipText === 'function' ? chip.trimChipText(guide) : chip.TRIM_CHIP_TEXT
console.log(JSON.stringify({ lines, armed: lines > PROJECT_INSTRUCTION_TRIM_LINE_THRESHOLD, guide, text }))
`
const driverDir = mkdtempSync(join(tmpdir(), 'effsize-drv-'))
const driverPath = join(driverDir, 'drv.ts')
writeFileSync(driverPath, driverSrc)

type Drive = { lines: number; armed: boolean; guide: string; text: string }
function drive(cwd: string): Drive {
  const home = mkdtempSync(join(tmpdir(), 'effsize-home-'))
  seedFirstRun(home, [cwd])
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(MERCURY_|CLAUDE_)/.test(k)) continue
    env[k] = v
  }
  env.MERCURY_CONFIG_DIR = home
  env.MERCURY_EVOLUTION_LEDGER = '0'
  const run = spawnSync(process.execPath, ['run', driverPath], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  })
  rmSync(home, { recursive: true, force: true })
  if (run.status !== 0) {
    console.error(`  [FAIL] driver exited ${run.status}: ${String(run.stderr).slice(0, 600)}`)
    process.exit(1)
  }
  const lines = String(run.stdout).trim().split('\n')
  return JSON.parse(lines[lines.length - 1]!) as Drive
}

console.log('real engine: a 3-line pointer at a 600-line guide ARMS')
const armFix = mkdtempSync(join(tmpdir(), 'effsize-arm-'))
execSync('git init -q', { cwd: armFix })
writeFileSync(
  join(armFix, 'MERCURY.md'),
  '@AGENTS.md\nThe guide is AGENTS.md; this file only points at it.\nSee the guide.\n',
)
writeFileSync(
  join(armFix, 'AGENTS.md'),
  Array.from({ length: 600 }, (_, i) => `guide line ${i}`).join('\n') + '\n',
)
const armed = drive(armFix)
check(armed.lines === 603, 'effective lines = 603 through the real walk', JSON.stringify(armed))
check(armed.armed === true, 'the chip arms past the bar')
check(armed.text === 'trim mercury.md to optimise performance and reduce context bloat', 'the chip names mercury.md, the guide it measured', armed.text)

console.log('real engine: a project whose only guide is a 600-line AGENTS.md ARMS and the chip names that guide')
const sharedFix = mkdtempSync(join(tmpdir(), 'effsize-shared-'))
execSync('git init -q', { cwd: sharedFix })
writeFileSync(
  join(sharedFix, 'AGENTS.md'),
  Array.from({ length: 600 }, (_, i) => `guide line ${i}`).join('\n') + '\n',
)
const shared = drive(sharedFix)
check(shared.lines === 600, 'effective lines = 600 through the real walk', JSON.stringify(shared))
check(shared.armed === true, 'the chip arms past the bar')
check(shared.text === 'trim agents.md to optimise performance and reduce context bloat', 'the chip names agents.md, the guide it measured', shared.text)

console.log('real engine: a personal MERCURY.local.md beside a 600-line AGENTS.md guide: both load, the chip names the guide')
const personalFix = mkdtempSync(join(tmpdir(), 'effsize-personal-'))
execSync('git init -q', { cwd: personalFix })
writeFileSync(join(personalFix, 'MERCURY.local.md'), 'my own notes\nline two\nline three\n')
writeFileSync(
  join(personalFix, 'AGENTS.md'),
  Array.from({ length: 600 }, (_, i) => `guide line ${i}`).join('\n') + '\n',
)
const personal = drive(personalFix)
check(personal.lines === 603, 'effective lines = 603: the guide and the personal layer both load', JSON.stringify(personal))
check(personal.armed === true, 'the chip arms past the bar')
check(personal.text === 'trim agents.md to optimise performance and reduce context bloat', 'the chip names agents.md, the guide it measured', personal.text)

console.log('real engine: 399 effective lines do NOT arm')
const calmFix = mkdtempSync(join(tmpdir(), 'effsize-calm-'))
execSync('git init -q', { cwd: calmFix })
writeFileSync(
  join(calmFix, 'MERCURY.md'),
  Array.from({ length: 399 }, (_, i) => `entry line ${i}`).join('\n') + '\n',
)
const calm = drive(calmFix)
check(calm.lines === 399, 'effective lines = 399', JSON.stringify(calm))
check(calm.armed === false, 'the chip stays down at 399')

console.log('real engine: rules files do not count toward the entry bar')
const rulesFix = mkdtempSync(join(tmpdir(), 'effsize-rules-'))
execSync('git init -q', { cwd: rulesFix })
writeFileSync(join(rulesFix, 'MERCURY.md'), 'one line of standing orders\n')
mkdirSync(join(rulesFix, '.mercury', 'rules'), { recursive: true })
writeFileSync(
  join(rulesFix, '.mercury', 'rules', 'big.md'),
  Array.from({ length: 600 }, (_, i) => `rule line ${i}`).join('\n') + '\n',
)
const rules = drive(rulesFix)
check(rules.lines === 1, 'a 600-line rules file leaves the measure at 1', JSON.stringify(rules))
check(rules.armed === false, 'rules weight never arms the mercury.md chip')

for (const dir of [armFix, sharedFix, personalFix, calmFix, rulesFix, driverDir]) rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL EFFECTIVE-SIZE LAWS HOLD' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
