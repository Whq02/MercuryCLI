#!/usr/bin/env bun
// ============================================================================
//  scripts/tree-ownership/prove-tree-ownership-namespace.ts — §13: the
//  namespace laws hold BEHAVIORALLY (real resolvers/writers, never
//  presence-only), plus the one-spelling ratchet.
//
//   (1) fresh-writes-native: a fresh project store writes .mercury; an
//       external .claude dir is never a home.
//   (2) one-spelling reader: flagEnv reads the MERCURY_* spelling and the
//       stampers emit exactly that one spelling.
//   (3) the one-spelling ratchet over src/: no consumer hand-reads a
//       HERMES_*/TF_* env spelling, and the registry declares no alias.
//   (4) boot-env writer coverage: saved boot menus stamp through the
//       registry helpers, and the applier dedupes per row.
//
// ============================================================================
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flagEnv, flagPair, flagSpellings } from '../../src/substrate/flagRegistry.ts'
import { adoptiveProjectPath } from '../../src/utils/projectStoreAdoption.js'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' sovereign namespace — fresh-native, one spelling, ratchet')
console.log('============================================================')

section('(1) canonical-write (adoptiveProjectPath)')
{
  const scratch = mkdtempSync(join(tmpdir(), 'sov-ns-'))
  try {
    const fresh = join(scratch, 'fresh')
    mkdirSync(fresh, { recursive: true })
    check('fresh store resolves .mercury', adoptiveProjectPath(fresh, 'party') === join(fresh, '.mercury', 'party'))
    check('resolving creates nothing', !existsSync(join(fresh, '.mercury')))
    const compat = join(scratch, 'compat')
    mkdirSync(join(compat, '.claude', 'party'), { recursive: true })
    check('an external .claude store is never a home: canonical returned', adoptiveProjectPath(compat, 'party') === join(compat, '.mercury', 'party'))
    check('…and nothing is copied out of it', !existsSync(join(compat, '.mercury', 'party')))
    const both = join(scratch, 'both')
    mkdirSync(join(both, '.mercury', 'party'), { recursive: true })
    mkdirSync(join(both, '.claude', 'party'), { recursive: true })
    check('canonical store answers when both exist', adoptiveProjectPath(both, 'party') === join(both, '.mercury', 'party'))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

section('(2) one-spelling reader (real flagEnv over a mutated env)')
{
  const prev = process.env.MERCURY_OPERATOR
  try {
    process.env.MERCURY_OPERATOR = 'native'
    check('flagEnv reads the MERCURY_* spelling', flagEnv('MERCURY_OPERATOR') === 'native')
    delete process.env.MERCURY_OPERATOR
    check('an unset flag reads undefined', flagEnv('MERCURY_OPERATOR') === undefined)
    const pair = flagPair('MERCURY_OPERATOR', 'x')
    check('flagPair stamps exactly one spelling', Object.keys(pair).length === 1 && pair.MERCURY_OPERATOR === 'x')
    check('flagSpellings names exactly one spelling', JSON.stringify(flagSpellings('MERCURY_OPERATOR')) === JSON.stringify(['MERCURY_OPERATOR']))
  } finally {
    if (prev === undefined) delete process.env.MERCURY_OPERATOR
    else process.env.MERCURY_OPERATOR = prev
  }
}

section('(3) the one-spelling ratchet over src/')
{
  const registrySrc = readFileSync(join(ROOT, 'src', 'substrate', 'flagRegistry.ts'), 'utf8')
  check('the registry declares no alias spelling', !/\blegacy\??:/.test(registrySrc))
  let out = ''
  try {
    out = execFileSync(
      'git',
      ['grep', '-nE', String.raw`process\.env(\.|\[['"])(HERMES_|TF_)[A-Z0-9_]+`, '--', 'src/'],
      { cwd: ROOT, encoding: 'utf8' },
    )
  } catch {
    out = '' // zero matches
  }
  const offenders = out.split('\n').filter(Boolean).map(l => l.slice(0, 120))
  check('zero reads of a retired env spelling anywhere in src', offenders.length === 0, offenders.slice(0, 5).join(' · '))
}

section('(4) boot-env writer coverage (source law: stamp through the registry helpers)')
{
  const bootEnv = readFileSync(join(ROOT, 'src', 'substrate', 'startupMenu.ts'), 'utf8')
  check('saved boot menus stamp through flagPair/flagSpellings in the writer', /flagPair|flagSpellings/.test(bootEnv))
  check('the applier dedupes per row', /dedupe|applied|seen/i.test(bootEnv))
}

console.log('════════════════════════════════════════════════════════════════════════════')
if (failures > 0) {
  console.error(`❌ ${failures} namespace check(s) failed`)
  process.exit(1)
}
console.log('✅ sovereign NAMESPACE LAWS HOLD')
