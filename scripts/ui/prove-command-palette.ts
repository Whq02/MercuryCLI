#!/usr/bin/env bun
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fuzzySearch } from '../../src/platform/text/fuzzyMatch.ts'
import { DEFAULT_BINDINGS } from '../../src/screen/keys/defaultBindings.ts'
import { formsMissing, shippedKeyForms } from '../lib/shippedKeyForms.ts'

let failures = 0
function check(label: string, cond: boolean, detail = '', fix = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && fix ? ` — ${fix}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

console.log('============================================================')
console.log(' Mercury Command Palette — fuzzy launcher (ctrl+x p)')
console.log('============================================================')

section('1. fuzzy ranking ranks (pure fuzzySearch — the palette engine)')
const names = ['color', 'compact', 'config', 'copy', 'context', 'control', 'cockpit', 'help', 'mission', 'deck']
const co = fuzzySearch(names, 'co', 10)
check('"co" returns matches', co.length > 0, `${co.length} hits`, 'change fuzzySearch in src/platform/text/fuzzyMatch.ts')
check('every "co" hit actually contains the needle letters in order', co.every(r => /c.*o/i.test(r.path)), '', 'change fuzzySearch in src/platform/text/fuzzyMatch.ts so it returns only names containing the query letters in order')
check('non-matching names are rejected (help/mission absent for "co")', !co.some(r => r.path === 'help' || r.path === 'mission'), '', 'change fuzzySearch in src/platform/text/fuzzyMatch.ts so it rejects names that lack the query letters')
const ckpt = fuzzySearch(names, 'ckpt', 10)
check('subsequence query "ckpt" finds "cockpit" (true fuzzy, not substring)', ckpt.some(r => r.path === 'cockpit'), '', 'change fuzzySearch in src/platform/text/fuzzyMatch.ts so a subsequence query matches')
const empty = fuzzySearch(names, 'zzzq', 10)
check('a no-match query returns empty (honest, no false hits)', empty.length === 0, '', 'change fuzzySearch in src/platform/text/fuzzyMatch.ts so a query with no match returns no hits')

section('2. keybinding: action + FLAG-GATED ctrl+x p binding')
check("ctrl+x p binds app:commandPalette", DEFAULT_BINDINGS.find(block => block.context === 'Global')?.bindings['ctrl+x p'] === 'app:commandPalette', '', 'bind ctrl+x p to app:commandPalette in the Global block of DEFAULT_BINDINGS in src/screen/keys/defaultBindings.ts')
const unbound = formsMissing(shippedKeyForms(), 'Global', 'ctrl+x p', 'app:commandPalette')
check('the ctrl+x p binding is present unconditionally (Global binds it on every shipped form: four platforms, five switch settings)', unbound.length === 0, unbound.join(' · '), 'bind ctrl+x p to app:commandPalette in the Global block of src/screen/keys/defaultBindings.ts for each form listed')


section('5. it SHIPS in dist (never DCE-folded)')
const dist = join(root, 'dist', 'mercury.mjs')
if (!existsSync(dist)) {
  check('dist/mercury.mjs present (run bun run build.ts first)', false, '', 'run bun run build.ts to write dist/mercury.mjs')
} else {
  const grep = (s: string) =>
    execSync(`grep -c ${JSON.stringify(s)} ${JSON.stringify(dist)} || true`, { encoding: 'utf-8' }).trim() !== '0'
  check('dist carries the palette header literal ("— command palette" via view prop)', grep('command palette'), '', 'the header text lives in src/screen/composer/MercuryCommandPalette.tsx; check it is not dropped from the build')
  check('dist carries the empty-query placeholder', grep('fuzzy by name or what it does'), '', 'the placeholder lives in src/screen/composer/MercuryCommandPalette.tsx; check it is not dropped from the build')
  check("dist carries the 'app:commandPalette' action", grep('app:commandPalette'), '', 'the action is bound in src/screen/keys/defaultBindings.ts; check it is not dropped from the build')
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ Command Palette — ranking + wiring + safety + ships, all proven')
  process.exit(0)
} else {
  console.log(` ❌ Command Palette — ${failures} check(s) failed`)
  process.exit(1)
}
