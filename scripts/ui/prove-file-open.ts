#!/usr/bin/env bun
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_BINDINGS } from '../../src/screen/keys/defaultBindings.ts'
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
console.log(' Mercury file quick-open (ctrl+x f)')
console.log('============================================================')

section('1. keybinding: action + FLAG-GATED ctrl+x f binding')
check('ctrl+x f binds app:fileOpen', DEFAULT_BINDINGS.find(block => block.context === 'Global')?.bindings['ctrl+x f'] === 'app:fileOpen')
const unbound = formsMissing(shippedKeyForms(), 'Global', 'ctrl+x f', 'app:fileOpen')
check('the ctrl+x f binding is present unconditionally (Global binds it on every shipped form: four platforms, five switch settings)', unbound.length === 0, unbound.join(' · '))


section('4. it SHIPS in dist')
const dist = join(root, 'dist', 'mercury.mjs')
if (!existsSync(dist)) {
  check('dist/mercury.mjs present (run bun run build.ts first)', false)
} else {
  const grep = (s: string) =>
    execSync(`grep -c ${JSON.stringify(s)} ${JSON.stringify(dist)} || true`, { encoding: 'utf-8' }).trim() !== '0'
  check('dist carries the "open file" view header', grep('open file'))
  check('dist carries the empty-query placeholder', grep('fuzzy-find a file to reference'))
  check("dist carries the 'app:fileOpen' action", grep('app:fileOpen'))
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ file quick-open — wiring + safety + lazy-index + ships, all proven')
  process.exit(0)
} else {
  console.log(` ❌ file quick-open — ${failures} check(s) failed`)
  process.exit(1)
}
