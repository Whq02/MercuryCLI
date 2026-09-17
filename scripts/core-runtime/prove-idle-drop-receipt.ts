#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const binding = await import('../../src/services/providers/anthropic/thinkingBinding.ts')
const { classifyThinkingDrops, describeThinkingDrops, prefixMarkOf, resetThinkingDropStates } = binding

type Drop = { type: string; path: string; reason: string }
const DROP: Drop = { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }

console.log('============================================================')
console.log(' the post-idle thinking drop — no independent idle arming; the drop reads as an ordinary preserved-thinking notice')
console.log('============================================================')

section('§1 the writer: no site arms a thinking-clear latch after the idle threshold, and the mark writer passes no such flag')
{
  const stream = src('src/services/providers/anthropic/streamCore.ts')
  const turn = src('src/run-core/turn-machine.ts')
  const state = src('src/bootstrap/state.ts')
  check('streamCore has no thinking-clear latch accessor (the arming site is gone)', !stream.includes('ThinkingClearLatched'), 'streamCore.ts still names a thinking-clear latch')
  check('streamCore does not arm a thinking-clear latch from the idle-hour completion gap', !/setThinkingClearLatched\(true\)/.test(stream) && !/thinkingClearLatched\s*=\s*true/.test(stream), 'an idle-hour arming survives in streamCore.ts')
  check('bootstrap state exposes no getThinkingClearLatched / setThinkingClearLatched', !state.includes('ThinkingClearLatched'), 'a thinking-clear latch accessor survives in state.ts')
  check('the mark writer (turn-machine) passes no thinkingClearActive into the prefix mark', !turn.includes('thinkingClearActive'), 'turn-machine.ts still passes thinkingClearActive')
  check('…and it passes only the request plan as the mark context', turn.includes('{ requestPlan: iter.requestPlan }'), 'the mark context is not the request-plan-only shape')
}

section('§2 the mark the product builds carries thinkingClearActive=false; the classifier vocabulary is retained (settable by hand, never by the product)')
{
  const rows = [
    { type: 'user', uuid: 'u-1', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'a-1', message: { id: 'm1', role: 'assistant', content: [], model: 'claude-fable-5-1' } },
  ]
  const productMark = prefixMarkOf(rows as never, 'claude-fable-5-1', { permissionMode: 'default' }, { requestPlan: undefined })
  check('the product mark reads thinkingClearActive === false (nothing arms it)', productMark.thinkingClearActive === false, JSON.stringify(productMark.thinkingClearActive))
  const armedMark = prefixMarkOf(rows as never, 'claude-fable-5-1', { permissionMode: 'default' }, { thinkingClearActive: true })
  check('the mark still accepts an explicit thinkingClearActive (the retained classifier vocabulary)', armedMark.thinkingClearActive === true, JSON.stringify(armedMark.thinkingClearActive))
  check("thinkingBinding still carries the 'thinking-cleared' lawful class (kept vocabulary)", src('src/services/providers/anthropic/thinkingBinding.ts').includes("'thinking-cleared'"))
}

section('§3 the consequence: a post-idle drop now classifies first / warning, where the old idle-armed latch made it lawful / info')
{
  const baseMark = {
    firstRow: 'u-1',
    compactBoundary: null,
    modelTransition: null,
    rosterTransition: null,
    rosterChange: null,
    model: 'claude-fable-5-1',
    settings: 'mode=default',
    contextEditActive: false,
  }
  resetThinkingDropStates()
  const nowOutcome = classifyThinkingDrops('idle-now', [DROP], { ...baseMark, thinkingClearActive: false } as never)
  const nowNote = describeThinkingDrops([DROP], nowOutcome)
  const nowSeverity = nowOutcome.kind === 'lawful' ? 'info' : 'warning'
  check('a post-idle drop is a FIRST unlawful drop today (kind first, lawful null)', nowOutcome.kind === 'first' && nowOutcome.lawful === null, JSON.stringify({ kind: nowOutcome.kind, lawful: nowOutcome.lawful }))
  check('…the receipt the turn machine writes for it is WARNING level', nowSeverity === 'warning', nowSeverity)
  check('…and its notice is never attributed to an idle clear', typeof nowNote === 'string' && !nowNote.includes('after an hour idle') && !nowNote.includes('cleared reasoning'), String(nowNote))

  resetThinkingDropStates()
  const thenOutcome = classifyThinkingDrops('idle-then', [DROP], { ...baseMark, thinkingClearActive: true } as never)
  const thenNote = describeThinkingDrops([DROP], thenOutcome)
  const thenSeverity = thenOutcome.kind === 'lawful' ? 'info' : 'warning'
  check('with the latch armed the SAME drop was a lawful thinking-cleared self-edit', thenOutcome.kind === 'lawful' && thenOutcome.lawful === 'thinking-cleared', JSON.stringify({ kind: thenOutcome.kind, lawful: thenOutcome.lawful }))
  check('…the receipt was INFO level', thenSeverity === 'info', thenSeverity)
  check('…and its notice named the idle clear', typeof thenNote === 'string' && thenNote.includes('after an hour idle'), String(thenNote))

  check('the transition is real: the two classifications and severities differ', nowOutcome.lawful !== thenOutcome.lawful && nowSeverity !== thenSeverity)
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} idle-drop-receipt check(s) failed`)
  process.exit(1)
}
console.log(' ALL IDLE-DROP-RECEIPT PROOFS PASS')
