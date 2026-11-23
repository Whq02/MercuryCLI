#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flagEnv, flagPair, flagSpellings } from '../../src/platform/substrate/flagRegistry.ts'
import { projectLocalPath } from '../../src/platform/project-local/paths.js'


let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' sovereign namespace — fresh-native, one spelling')
console.log('============================================================')

section('(1) canonical-write (projectLocalPath)')
{
  const scratch = mkdtempSync(join(tmpdir(), 'sov-ns-'))
  try {
    const fresh = join(scratch, 'fresh')
    mkdirSync(fresh, { recursive: true })
    check('fresh store resolves .mercury', projectLocalPath(fresh, 'party') === join(fresh, '.mercury', 'party'), 'projectLocalPath in src/platform/project-local/paths.ts must return <root>/.mercury/<name> for a fresh root')
    check('resolving creates nothing', !existsSync(join(fresh, '.mercury')), 'projectLocalPath in src/platform/project-local/paths.ts must only compute the path, never create a directory')
    const compat = join(scratch, 'compat')
    mkdirSync(join(compat, '.claude', 'party'), { recursive: true })
    check('an external .claude store is never a home: canonical returned', projectLocalPath(compat, 'party') === join(compat, '.mercury', 'party'), 'projectLocalPath in src/platform/project-local/paths.ts must ignore an existing .claude store and return the .mercury path')
    check('…and nothing is copied out of it', !existsSync(join(compat, '.mercury', 'party')), 'projectLocalPath in src/platform/project-local/paths.ts must not copy or migrate a .claude store into .mercury')
    const both = join(scratch, 'both')
    mkdirSync(join(both, '.mercury', 'party'), { recursive: true })
    mkdirSync(join(both, '.claude', 'party'), { recursive: true })
    check('canonical store answers when both exist', projectLocalPath(both, 'party') === join(both, '.mercury', 'party'), 'projectLocalPath in src/platform/project-local/paths.ts must answer with the .mercury store when both exist')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

section('(2) one-spelling reader (real flagEnv over a mutated env)')
{
  const prev = process.env.MERCURY_OPERATOR
  try {
    process.env.MERCURY_OPERATOR = 'native'
    check('flagEnv reads the MERCURY_* spelling', flagEnv('MERCURY_OPERATOR') === 'native', 'flagEnv in the flag registry (FLAG_REGISTRY) must read the MERCURY_ spelling from process.env')
    delete process.env.MERCURY_OPERATOR
    check('an unset flag reads undefined', flagEnv('MERCURY_OPERATOR') === undefined, 'flagEnv in the flag registry (FLAG_REGISTRY) must return undefined when the variable is unset')
    const pair = flagPair('MERCURY_OPERATOR', 'x')
    check('flagPair stamps exactly one spelling', Object.keys(pair).length === 1 && pair.MERCURY_OPERATOR === 'x', `got ${JSON.stringify(pair)} — flagPair in the flag registry (FLAG_REGISTRY) must return only the MERCURY_ key`)
    check('flagSpellings names exactly one spelling', JSON.stringify(flagSpellings('MERCURY_OPERATOR')) === JSON.stringify(['MERCURY_OPERATOR']), `got ${JSON.stringify(flagSpellings('MERCURY_OPERATOR'))} — flagSpellings in the flag registry (FLAG_REGISTRY) must list only the MERCURY_ spelling`)
  } finally {
    if (prev === undefined) delete process.env.MERCURY_OPERATOR
    else process.env.MERCURY_OPERATOR = prev
  }
}


console.log('════════════════════════════════════════════════════════════════════════════')
if (failures > 0) {
  console.error(`❌ ${failures} namespace check(s) failed`)
  process.exit(1)
}
console.log('✅ sovereign NAMESPACE LAWS HOLD')
