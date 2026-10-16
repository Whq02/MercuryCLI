#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
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
const J = (...parts: string[]): string => parts.join('')
const RETIRED = J('MERCURY_GLOB_', 'NO_IGNORE')

console.log('============================================================')
console.log(' glob env toggles — ignore files apply by default; the hidden toggle stays')
console.log('============================================================')

section('source: the walk respects ignore files; only the hidden toggle is a registered spelling')
check(
  'MERCURY_GLOB_HIDDEN gates --hidden',
  /envFlagDefaultOn\('MERCURY_GLOB_HIDDEN'\)\) \{\s*args\.push\('--hidden'\)\s*universeArgs\.push\('--hidden'\)/.test(globUtil),
)
check(
  "the listing is the pattern's full match walk intersected with ripgrep's own non-ignored universe (a --glob override whitelists any ignored folder the pattern itself matches, so the ignore law cannot ride the match walk alone)",
  /const universeArgs = \['--files', '--sortr=modified'\]/.test(globUtil) && /const listed = new Set\(universe\.lines\)/.test(globUtil) && /matches\.lines\.filter\(entry => listed\.has\(entry\)\)/.test(globUtil),
)
check(
  "what the ignore files hid is counted for the result's tail, never listed first",
  /ignored: complete \? matches\.lines\.length - kept\.length : 0/.test(globUtil),
)
check(
  'no env spelling gates the ignore law any more (only the hidden toggle reads env)',
  (globUtil.match(/envFlagDefaultOn\('/g) ?? []).length === 1,
)
check(
  'the decoder is the documented default-on form (unset OR empty ⇒ enabled)',
  /raw === undefined \|\| raw === '' \? '1' : raw/.test(globUtil),
)

section('the retired spelling is an unknown input: no reader, no registry row, no alias, no refusal line')
const grep = (dir: string): string => {
  try {
    return execFileSync('grep', ['-rl', RETIRED, join(ROOT, dir)], { encoding: 'utf8' })
  } catch {
    return ''
  }
}
const readers = ['src', 'docs', 'assets', 'README.md'].flatMap(dir => grep(dir).split('\n').filter(Boolean).map(p => p.replace(`${ROOT}/`, '')))
check('nothing under src, docs, assets or the README spells it', readers.length === 0, readers.join(', '))
const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.ts')
check('the flag registry carries no row for it', !FLAG_REGISTRY.some(f => f.env === RETIRED))
check('the hidden toggle keeps its row', FLAG_REGISTRY.some(f => f.env === 'MERCURY_GLOB_HIDDEN' && f.kind === 'default-on'))

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
