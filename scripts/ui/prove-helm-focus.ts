#!/usr/bin/env bun
// prove-helm-focus.ts — locks the A2.2 Phase-3 cockpit focus model's pure logic
// (utils/cockpit/helmFocus.ts): the Tab cycle order, the row→action mapping,
// cursor clamping (including clamp-on-shrink), and the publish signature no-op
// (an unchanged row model must NOT notify — a publish→notify→render loop was
// the failure mode this guards).
import {
  consumeCommandDispatch,
  currentHelmRow,
  cycleHelmFocus,
  getHelmCursor,
  getHelmFocus,
  getHelmVersion,
  helmRailPastEntryBuffer,
  helmRowAction,
  moveHelmCursor,
  nextHelmPane,
  publishHelmRows,
  requestCommandDispatch,
  resetHelmFocusForTest,
  setHelmFocus,
  type HelmRow,
} from '../../src/utils/cockpit/helmFocus.js'

let fail = 0
const t = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

// 1) Tab cycle order: prompt → lanes → telemetry → prompt.
t('cycle order', nextHelmPane('prompt') === 'lanes' && nextHelmPane('lanes') === 'telemetry' && nextHelmPane('telemetry') === 'prompt')

// 2) Row → action mapping.
const crew: HelmRow = { kind: 'teammate', id: 'task-7', label: 'scout' }
const cmd: HelmRow = { kind: 'command', command: '/trace', label: 'trace:0' }
const a1 = helmRowAction(crew)
const a2 = helmRowAction(cmd)
t('teammate row → drill action', a1?.type === 'teammate' && a1.id === 'task-7')
t('command row → surface action', a2?.type === 'command' && a2.command === '/trace')
t('no row → null action', helmRowAction(undefined) === null)

// 3) Focus setters notify; cycle mutates.
resetHelmFocusForTest()
const v0 = getHelmVersion()
setHelmFocus('lanes')
t('setHelmFocus notifies', getHelmFocus() === 'lanes' && getHelmVersion() === v0 + 1)
cycleHelmFocus()
t('cycleHelmFocus advances', getHelmFocus() === 'telemetry')

// 4) Cursor moves clamp at both ends.
resetHelmFocusForTest()
const rows3: HelmRow[] = [
  { kind: 'command', command: '/a', label: 'a' },
  { kind: 'command', command: '/b', label: 'b' },
  { kind: 'command', command: '/c', label: 'c' },
]
publishHelmRows('lanes', rows3)
moveHelmCursor('lanes', -1)
t('cursor clamps at 0', getHelmCursor('lanes') === 0)
moveHelmCursor('lanes', +1)
moveHelmCursor('lanes', +1)
moveHelmCursor('lanes', +9)
t('cursor clamps at max', getHelmCursor('lanes') === 2)
t('currentHelmRow follows cursor', currentHelmRow('lanes')?.label === 'c')

// 5) Publish shrink re-clamps the cursor (rows vanish under it).
publishHelmRows('lanes', rows3.slice(0, 1))
t('cursor re-clamps on shrink', getHelmCursor('lanes') === 0 && currentHelmRow('lanes')?.label === 'a')

// 6) Same-signature publish is a no-op (no notify → no render loop).
const vBefore = getHelmVersion()
publishHelmRows('lanes', rows3.slice(0, 1))
t('unchanged publish does not notify', getHelmVersion() === vBefore)

// 7) Distinct panes hold distinct cursors.
resetHelmFocusForTest()
publishHelmRows('lanes', rows3)
publishHelmRows('telemetry', rows3)
moveHelmCursor('lanes', +2)
t('per-pane cursors independent', getHelmCursor('lanes') === 2 && getHelmCursor('telemetry') === 0)

// 8) The generic command-dispatch channel (trust-cockpit W4): request → notify
//    → consume-once; last-write-wins (single operator gestures, not a queue).
resetHelmFocusForTest()
{
  const v0 = getHelmVersion()
  requestCommandDispatch('/fleet')
  t('command request notifies subscribers', getHelmVersion() === v0 + 1)
  t('consume returns the command once', consumeCommandDispatch() === '/fleet')
  t('second consume is empty (drained)', consumeCommandDispatch() === null)
  requestCommandDispatch('/trace')
  requestCommandDispatch('/substrate')
  t('last-write-wins', consumeCommandDispatch() === '/substrate')
  resetHelmFocusForTest()
  t('reset clears a pending command', consumeCommandDispatch() === null)
}

// 9) Rail-entry buffer: ↵ is gated for ~150ms after focus ENTERS a rail (the
//    idle-parked-commits / STALE-PAINT discipline on a focus transition) —
//    a module TIMESTAMP comparator, so it holds with zero React commits.
resetHelmFocusForTest()
{
  t('after reset the buffer is open (no entry recorded)', helmRailPastEntryBuffer() === true)
  setHelmFocus('lanes')
  t('entering a rail arms the buffer (↵ gated)', helmRailPastEntryBuffer() === false)
  t('a zero-ms buffer is already past (comparator, not a flag)', helmRailPastEntryBuffer(0) === true)
  cycleHelmFocus() // lanes → telemetry: a rail→rail transition re-arms
  t('rail→rail cycle re-arms the buffer', helmRailPastEntryBuffer() === false)
  setHelmFocus('prompt') // leaving the rails does NOT re-arm
  const armedAtLeave = !helmRailPastEntryBuffer()
  t('returning to prompt does not extend the arm window', armedAtLeave === true) // still inside 150ms of the last entry
  await new Promise(r => setTimeout(r, 170))
  t('the buffer opens after the window elapses', helmRailPastEntryBuffer() === true)
}

console.log(fail ? '❌ HELM-FOCUS RED' : '✅ HELM-FOCUS GREEN')
process.exit(fail)
