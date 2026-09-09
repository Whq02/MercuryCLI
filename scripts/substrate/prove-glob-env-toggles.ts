#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const globUtil = readFileSync(join(ROOT, 'src', 'utils', 'glob.ts'), 'utf-8')

console.log('============================================================')
console.log(' glob env toggles — default-ON gates, the registered spellings')
console.log('============================================================')

section('source: the two registered spellings gate the two ripgrep flags')
check(
  'MERCURY_GLOB_NO_IGNORE gates --no-ignore',
  /envFlagDefaultOn\('MERCURY_GLOB_NO_IGNORE'\)\) args\.push\('--no-ignore'\)/.test(globUtil),
)
check(
  'MERCURY_GLOB_HIDDEN gates --hidden',
  /envFlagDefaultOn\('MERCURY_GLOB_HIDDEN'\)\) args\.push\('--hidden'\)/.test(globUtil),
)
check(
  'the decoder is the documented default-on form (unset OR empty ⇒ enabled)',
  /raw === undefined \|\| raw === '' \? '1' : raw/.test(globUtil),
)

section('behavioural mirror: the pure default-on decode (unset/empty ⇒ ON, falsy ⇒ OFF)')
const truthy = (v: string): boolean => ['1', 'true', 'yes', 'on'].includes(v.toLowerCase().trim())
const decode = (raw: string | undefined): boolean => truthy(raw === undefined || raw === '' ? '1' : raw)
check('unset ⇒ ON', decode(undefined) === true)
check("'' ⇒ ON (empty counts as unset)", decode('') === true)
check("'1' ⇒ ON", decode('1') === true)
check("'0' ⇒ OFF", decode('0') === false)
check("'false' ⇒ OFF", decode('false') === false)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL GLOB-ENV-TOGGLE PROOFS PASS')
else console.log(`❌ ${failures} GLOB-ENV-TOGGLE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
