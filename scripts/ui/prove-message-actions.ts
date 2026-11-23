#!/usr/bin/env bun
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formsMissing, rowsBinding, shippedKeyForms } from '../lib/shippedKeyForms.ts'

let failures = 0
function check(label: string, cond: boolean, detail = '', fixHint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond && fixHint) console.log('         to change: ' + fixHint)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

console.log('============================================================')
console.log(' MESSAGE_ACTIONS — fork-enabled (shift+up message cursor)')
console.log('============================================================')

section('1. keybindings: BOTH gates carry the stamp arms')
const { DEFAULT_BINDINGS } = await import('../../src/screen/keys/defaultBindings.ts')
const shipped = shippedKeyForms()
const gateShiftUp = formsMissing(shipped, 'Chat', 'shift+up', 'chat:messageActions').length === 0
const gateContext = shipped.every(form => rowsBinding([form], (_action, _chord, context) => context === 'MessageActions').length > 0)
const forkArmedGates = [gateShiftUp, gateContext].filter(Boolean)
check('both message-actions keybinding groups are present unconditionally ', forkArmedGates.length === 2, `${forkArmedGates.length}/2`, 'src/screen/keys/defaultBindings.ts must bind shift+up to chat:messageActions in the Chat context and carry a MessageActions context for every shipped key form')
check('shift+up still maps to chat:messageActions', DEFAULT_BINDINGS.find(block => block.context === 'Chat')?.bindings['shift+up'] === 'chat:messageActions', '', 'the Chat block of DEFAULT_BINDINGS in src/screen/keys/defaultBindings.ts must map shift+up to chat:messageActions')
const navMissing = ['messageActions:prev', 'messageActions:next', 'messageActions:escape'].flatMap(nav =>
  shipped.filter(form => rowsBinding([form], (action, _chord, context) => context === 'MessageActions' && action === nav).length === 0).map(form => `${form.form} lacks ${nav}`),
)
check('the MessageActions nav context survives (prev/next/escape)', navMissing.length === 0, navMissing.join(' · '), 'add the missing messageActions binding to the MessageActions context in src/screen/keys/defaultBindings.ts')

section('2. Chat: a single messageActionsDisabled gate, used at every render site')
const { openSelectorPart } = await import('./chatScenarios.ts')
const selectorPart = await openSelectorPart('message-actions-selector')
const disabledFlags = [selectorPart.part.value().messageActionsDisabled]
await selectorPart.plant({ focusedInputDialog: undefined, chatSurfaceCovered: true })
disabledFlags.push(selectorPart.part.value().messageActionsDisabled)
await selectorPart.close()
check('messageActionsDisabled is false unconditionally (no feature flag)', disabledFlags.join() === 'false,false', disabledFlags.join(), 'messageActionsDisabled in src/screen/chat/useChatSelector.tsx must not depend on a feature flag or on the covered surface')
const { openKeysPart } = await import('./chatScenarios.ts')
const keys = await openKeysPart('message-actions-keys')
await keys.plant({ messageCursorActive: true })
const activeWhenEnabled = keys.handed.actions?.isActive
await keys.plant({ messageActionsDisabled: true })
const activeWhenDisabled = keys.handed.actions?.isActive
await keys.plant({ messageActionsDisabled: false, focusedInputDialog: 'tool-permission' })
const activeUnderDialog = keys.handed.actions?.isActive
await keys.close()
check('the MessageActionsKeybindings the chat screen mounts gate on the one disabled flag and on no dialog having the focus', activeWhenEnabled === true && activeWhenDisabled === false && activeUnderDialog === false, `${String(activeWhenEnabled)} · ${String(activeWhenDisabled)} · ${String(activeUnderDialog)}`, 'the isActive gate of MessageActionsKeybindings in src/screen/chat/ChatKeys.tsx must follow messageActionsDisabled and the focused input dialog')


section('4. it SHIPS in dist')
const dist = join(root, 'dist', 'mercury.mjs')
if (!existsSync(dist)) {
  check('dist present', false, '', 'build first with: bun run build.ts (writes dist/mercury.mjs)')
} else {
  const grep = (s: string) =>
    execSync(`grep -c ${JSON.stringify(s)} ${JSON.stringify(dist)} || true`, { encoding: 'utf-8' }).trim() !== '0'
  check("dist carries 'chat:messageActions'", grep('chat:messageActions'), '', 'rebuild with bun run build.ts; if it is still missing, src/screen/keys/defaultBindings.ts no longer ships chat:messageActions')
  check("dist carries the MessageActions nav context", grep('messageActions:prevUser'), '', 'rebuild with bun run build.ts; if it is still missing, src/screen/keys/defaultBindings.ts no longer ships messageActions:prevUser')
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ MESSAGE_ACTIONS fork-enabled — gates + env opt-out + ships, all proven')
  process.exit(0)
} else {
  console.log(` ❌ MESSAGE_ACTIONS — ${failures} check(s) failed`)
  process.exit(1)
}
