#!/usr/bin/env bun
// prove-cli-verb-honesty — three CLI-verb defects (field cards FC-045 ·
// FC-046 · FC-047).
//
// FC-045: `mercury themis` wrote refusals, errors and usage to STDOUT with
//   stderr empty, against the channel discipline every other subcommand
//   honours. Facts stay on stdout; refusals/usage now ride stderr.
// FC-046: on Windows the `code` CLI could never be detected — the probe ran
//   without the .cmd spelling or a shell, so `editor status` reported
//   VS Code absent while `code --version` worked. The probe now tries
//   code.cmd/code/code.exe under shell:true on win32 (live leg field-owed).
// FC-047: the bounded-int env readers used parseInt's prefix leniency —
//   `1e6` became a 1-character limit, `12abc` became 12, doctor said ok.
//   Strict whole-number parse now (the apiTimeoutMsOverride law).
//
//   §1 FC-047 behavioral: the card's own value matrix.
//   §2 FC-046 structural: win32 candidates + shell ride (call-shaped).
//   §3 FC-045 artifact: themis refusal/usage on stderr, facts on stdout.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { validateBoundedIntEnvVar } = await import('../../src/utils/envValidation.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const ROOT = join(import.meta.dir, '..', '..')

section('§1 FC-047 — the value matrix')
{
  const v = (raw: string | undefined) => validateBoundedIntEnvVar('PROBE', raw, 30000, 150000)
  check('a plain number stands', v('30000').effective === 30000 && v('30000').status === 'valid')
  check('1e6 parses as the integer it names, then caps', v('1e6').effective === 150000 && v('1e6').status === 'capped', JSON.stringify(v('1e6')))
  check('12abc is rejected WHOLE (was 12)', v('12abc').effective === 30000 && v('12abc').status === 'invalid', JSON.stringify(v('12abc')))
  check('30_000 is rejected whole', v('30_000').status === 'invalid')
  check('a float is rejected', v('3.9').status === 'invalid')
  check('a negative is rejected', v('-5').status === 'invalid')
  check('surrounding whitespace is tolerated', v('  50  ').effective === 50)
  check('unset keeps the default', v(undefined).effective === 30000)
  check('999999999 caps at the ceiling', v('999999999').effective === 150000 && v('999999999').status === 'capped')
}

section('§2 FC-046 — the win32 code probe (structural)')
{
  const bridge = readFileSync(join(ROOT, 'src/cli/editorBridge.ts'), 'utf8')
  check("the win32 candidate list leads with code.cmd", /'code\.cmd', 'code', 'code\.exe'/.test(bridge))
  check('and the probe rides shell:true on win32 (a .cmd cannot spawn shell-less)', /isWindows \? \{ shell: true \} : \{\}/.test(bridge))
}

section('§3 FC-045 — themis channel discipline (artifact)')
{
  const DIST = join(ROOT, 'dist', 'mercury.mjs')
  if (!existsSync(DIST)) {
    check('dist/mercury.mjs exists (build first — this leg drives the artifact)', false)
  } else {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'themis-channel-')))
    const run = (args: string[], env: Record<string, string> = {}) =>
      spawnSync('node', [DIST, ...args], {
        env: { ...process.env, MERCURY_CONFIG_DIR: home, ...env },
        encoding: 'utf8',
        timeout: 60_000,
      })
    const refused = run(['themis', 'lock'], { MERCURY_THEMIS: 'off' })
    check('a refusal exits 1', refused.status === 1, `status=${refused.status}`)
    check('the refusal rides STDERR (FC-045)', /refused/.test(refused.stderr ?? ''), JSON.stringify((refused.stderr ?? '').slice(0, 100)))
    check('and stdout stays clean', !/refused/.test(refused.stdout ?? ''), JSON.stringify((refused.stdout ?? '').slice(0, 80)))
    const usage = run(['themis', 'bogusverb'])
    check('usage exits 2 on stderr', usage.status === 2 && /Usage:/.test(usage.stderr ?? '') && !/Usage:/.test(usage.stdout ?? ''), `status=${usage.status}`)
    const verify = run(['themis', 'verify'], { MERCURY_THEMIS: 'off' })
    check('facts still ride stdout (verify level line)', /level: off/.test(verify.stdout ?? ''), JSON.stringify((verify.stdout ?? '').slice(0, 60)))
    rmSync(home, { recursive: true, force: true })
  }
}

if (failures > 0) {
  console.error(`\nprove-cli-verb-honesty: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-cli-verb-honesty: all green')
