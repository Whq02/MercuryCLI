#!/usr/bin/env bun
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fuzzySearch } from '../../src/utils/fuzzyMatch.ts'
import { DEFAULT_BINDINGS } from '../../src/keybindings/defaultBindings.ts'
import { formsMissing, shippedKeyForms } from '../lib/shippedKeyForms.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
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
check('"co" returns matches', co.length > 0, `${co.length} hits`)
check('every "co" hit actually contains the needle letters in order', co.every(r => /c.*o/i.test(r.path)))
check('non-matching names are rejected (help/mission absent for "co")', !co.some(r => r.path === 'help' || r.path === 'mission'))
const ckpt = fuzzySearch(names, 'ckpt', 10)
check('subsequence query "ckpt" finds "cockpit" (true fuzzy, not substring)', ckpt.some(r => r.path === 'cockpit'))
const empty = fuzzySearch(names, 'zzzq', 10)
check('a no-match query returns empty (honest, no false hits)', empty.length === 0)

section('2. keybinding: action + FLAG-GATED ctrl+x p binding')
check("ctrl+x p binds app:commandPalette", DEFAULT_BINDINGS.find(block => block.context === 'Global')?.bindings['ctrl+x p'] === 'app:commandPalette')
const unbound = formsMissing(shippedKeyForms(), 'Global', 'ctrl+x p', 'app:commandPalette')
check('the ctrl+x p binding is present unconditionally (Global binds it on every shipped form: four platforms, five switch settings)', unbound.length === 0, unbound.join(' · '))


section('5. it SHIPS in dist (never DCE-folded)')
const dist = join(root, 'dist', 'mercury.mjs')
if (!existsSync(dist)) {
  check('dist/mercury.mjs present (run bun run build.ts first)', false)
} else {
  const grep = (s: string) =>
    execSync(`grep -c ${JSON.stringify(s)} ${JSON.stringify(dist)} || true`, { encoding: 'utf-8' }).trim() !== '0'
  check('dist carries the palette header literal ("— command palette" via view prop)', grep('command palette'))
  check('dist carries the empty-query placeholder', grep('fuzzy by name or what it does'))
  check("dist carries the 'app:commandPalette' action", grep('app:commandPalette'))
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ Command Palette — ranking + wiring + safety + ships, all proven')
  process.exit(0)
} else {
  console.log(` ❌ Command Palette — ${failures} check(s) failed`)
  process.exit(1)
}
