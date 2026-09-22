#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
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

if (failures > 0) {
  console.error(`\nprove-cli-verb-honesty: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-cli-verb-honesty: all green')
