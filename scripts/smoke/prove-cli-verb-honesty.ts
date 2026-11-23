#!/usr/bin/env bun

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { validateBoundedIntEnvVar } = await import('../../src/platform/environment/envValidation.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = '', fix = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && fix ? ' — fix: ' + fix : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

section('§1 FC-047 — the value matrix')
{
  const v = (raw: string | undefined) => validateBoundedIntEnvVar('PROBE', raw, 30000, 150000)
  check('a plain number stands', v('30000').effective === 30000 && v('30000').status === 'valid', '', 'validateBoundedIntEnvVar in src/platform/environment/envValidation.ts must return the number itself with status valid')
  check('1e6 parses as the integer it names, then caps', v('1e6').effective === 150000 && v('1e6').status === 'capped', JSON.stringify(v('1e6')), 'validateBoundedIntEnvVar in src/platform/environment/envValidation.ts must parse 1e6 as 1000000 and cap it at the ceiling with status capped')
  check('12abc is rejected WHOLE (was 12)', v('12abc').effective === 30000 && v('12abc').status === 'invalid', JSON.stringify(v('12abc')), 'validateBoundedIntEnvVar in src/platform/environment/envValidation.ts must reject the whole string and return the default with status invalid')
  check('30_000 is rejected whole', v('30_000').status === 'invalid', '', 'validateBoundedIntEnvVar in src/platform/environment/envValidation.ts must reject digit separators as invalid')
  check('a float is rejected', v('3.9').status === 'invalid', '', 'validateBoundedIntEnvVar in src/platform/environment/envValidation.ts must reject a non-integer as invalid')
  check('a negative is rejected', v('-5').status === 'invalid', '', 'validateBoundedIntEnvVar in src/platform/environment/envValidation.ts must reject a negative number as invalid')
  check('surrounding whitespace is tolerated', v('  50  ').effective === 50, '', 'validateBoundedIntEnvVar in src/platform/environment/envValidation.ts must trim surrounding whitespace before parsing')
  check('unset keeps the default', v(undefined).effective === 30000, '', 'validateBoundedIntEnvVar in src/platform/environment/envValidation.ts must return the default when the variable is unset')
  check('999999999 caps at the ceiling', v('999999999').effective === 150000 && v('999999999').status === 'capped', '', 'validateBoundedIntEnvVar in src/platform/environment/envValidation.ts must cap a value above the ceiling at the ceiling with status capped')
}


if (failures > 0) {
  console.error(`\nprove-cli-verb-honesty: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-cli-verb-honesty: all green')
