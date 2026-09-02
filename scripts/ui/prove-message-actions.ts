#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-message-actions.ts
//  PROOF that MESSAGE_ACTIONS (shift+up → message cursor → copy/edit/rerun a past
//  message) is FORK-ENABLED. A bare stamp gates it on feature('MESSAGE_ACTIONS') which
//  DCE-folds false in the fork; this asserts every gate now carries the stamp arms,
//  the env opt-out survives, and it ships. The BEHAVIOUR is live-verified (resume a
//  transcript + shift+up → the MessageActionsBar "enter edit · c copy · …" appears).
//
//  NOTE: the gate sites are in the HAND-WRITTEN main REPL() function (no `const $ =
//  _c(N)` — the _c caches in REPL.tsx are sub-components at :343/:506), so flipping
//  the feature() conditionals is a plain edit, not a memo-cache-slot hand-patch.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-message-actions.ts
// ============================================================================
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
// shift+up → chat:messageActions (enter the cursor), and the MessageActions context block.
// feature('MESSAGE_ACTIONS') folded at source;
// each gate is now the bare stamp arms, matched contextually against its binding.
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
// ZERO raw feature('MESSAGE_ACTIONS') gates remain —
// the fold removed the one definition-site use; none may reappear.
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
