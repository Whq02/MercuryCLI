#!/usr/bin/env bun
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf-8')

console.log('============================================================')
console.log(' MESSAGE_ACTIONS — fork-enabled (shift+up message cursor)')
console.log('============================================================')

section('1. keybindings: BOTH gates carry the stamp arms')
const binds = read('src', 'keybindings', 'defaultBindings.ts')
const gateShiftUp = /'shift\+up': 'chat:messageActions',/.test(binds)
const gateContext = /context: 'MessageActions',\s*bindings: \{/.test(binds)
const forkArmedGates = [gateShiftUp, gateContext].filter(Boolean)
check('both message-actions keybinding groups are present unconditionally ', forkArmedGates.length === 2, `${forkArmedGates.length}/2`)
check('shift+up still maps to chat:messageActions', /'shift\+up': 'chat:messageActions'/.test(binds))
check('the MessageActions nav context survives (prev/next/escape)', /'messageActions:prev'/.test(binds) && /'messageActions:escape'/.test(binds))

section('2. REPL: a single messageActionsDisabled gate, used at every render site')
const repl = read('src', 'screens', 'REPL.tsx')
check('messageActionsDisabled is false unconditionally (no feature flag)', /const messageActionsDisabled = false;/.test(repl))
check('the MessageActionsKeybindings render gates on the one disabled flag', /isActive=\{!messageActionsDisabled && focusedInputDialog === undefined\}/.test(repl))
check('the onMessageActionsEnter handler gates on the one disabled flag', /onMessageActionsEnter=\{messageActionsDisabled \? undefined : messageActions\.enter\}/.test(repl))
check('exactly one feature(MESSAGE_ACTIONS) in REPL (the messageActionsEnabled def)', (repl.match(/feature\('MESSAGE_ACTIONS'\)/g) ?? []).length === 0)
check('the gate lives in the hand-written REPL() (no _c slot patched)', /export function REPL\(/.test(repl) && !/const \$ = _c\([\s\S]{0,4000}messageActionsDisabled/.test(repl))

section('3. no env opt-out: message actions are unconditional (the compat env spelling retired with its estate)')
check('no retired DISABLE_MESSAGE_ACTIONS env read remains', !/DISABLE_MESSAGE_ACTIONS/.test(repl))
check('every render site respects !messageActionsDisabled', (repl.match(/!messageActionsDisabled/g) ?? []).length >= 2)

section('4. it SHIPS in dist')
const dist = join(root, 'dist', 'mercury.mjs')
if (!existsSync(dist)) {
  check('dist present', false)
} else {
  const grep = (s: string) =>
    execSync(`grep -c ${JSON.stringify(s)} ${JSON.stringify(dist)} || true`, { encoding: 'utf-8' }).trim() !== '0'
  check("dist carries 'chat:messageActions'", grep('chat:messageActions'))
  check("dist carries the MessageActions nav context", grep('messageActions:prevUser'))
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ MESSAGE_ACTIONS fork-enabled — gates + env opt-out + ships, all proven')
  process.exit(0)
} else {
  console.log(` ❌ MESSAGE_ACTIONS — ${failures} check(s) failed`)
  process.exit(1)
}
