#!/usr/bin/env bun
// ============================================================================
//  scripts/self-hosting/prove-effective-size.ts — the effective-size measure
//  behind the standing trim chip.
//
//  Laws pinned:
//    · EFFECTIVE means entry PLUS imports: a 3-line pointer at a 600-line
//      guide measures 603 and ARMS the chip (>400); a 399-line entry does
//      not. Driven through the REAL engine on scratch fixtures (scratch
//      config home, hermetic child) — the same discovery the prompt reads.
//    · The measure counts the PROJECT estate only: user-scope files and
//      rules-directory files stay outside (the chip's advice is "trim
//      mercury.md").
//    · The threshold constant is the ruled ~400.
//
//  Run: ~/.bun/bin/bun run scripts/self-hosting/prove-effective-size.ts
// ============================================================================
import { execSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
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

// ── pure legs: the measure's scope rules ───────────────────────────────────
const { measureEffectiveProjectInstructionLines, PROJECT_INSTRUCTION_TRIM_LINE_THRESHOLD } =
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

// ── real-engine legs: fixtures through the actual discovery ────────────────
const driverSrc = `
import { enableConfigs } from '${repo}/src/utils/config/globalConfig.js'
enableConfigs()
const { getInstructionFiles } = await import('${repo}/src/services/instructions/engine.js')
const { measureEffectiveProjectInstructionLines, PROJECT_INSTRUCTION_TRIM_LINE_THRESHOLD } =
  await import('${repo}/src/services/instructions/effectiveSize.js')
const lines = measureEffectiveProjectInstructionLines(await getInstructionFiles())
console.log(JSON.stringify({ lines, armed: lines > PROJECT_INSTRUCTION_TRIM_LINE_THRESHOLD }))
`
const driverDir = mkdtempSync(join(tmpdir(), 'effsize-drv-'))
const driverPath = join(driverDir, 'drv.ts')
writeFileSync(driverPath, driverSrc)

function drive(cwd: string): { lines: number; armed: boolean } {
  const home = mkdtempSync(join(tmpdir(), 'effsize-home-'))
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(MERCURY_|HERMES_|TF_|CLAUDE_)/.test(k)) continue
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
  return JSON.parse(lines[lines.length - 1]!) as { lines: number; armed: boolean }
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

console.log(failures === 0 ? '\nALL EFFECTIVE-SIZE LAWS HOLD' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
