#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-tier-overlay.ts
//  PROOF (router-party P3; re-pinned at the wrapper-pack
//  retirement): the seat doctrine tier. seatDoctrineTier classifies
//  the RESOLVED slot model (Opus 4.x/5 + Fable/Mythos ⇒ orchestrator;
//  Sonnet-5 ⇒ executor; anything else ⇒ unknown — honest base prose, no
//  false doctrine); the mode-pack builders swap in the tighter executor
//  doctrine ONLY on an executor slot, byte-identical base otherwise; the
//  mode bridges pass the tier from the resolved seat.
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-tier-overlay.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void { console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76)) }
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' Seat doctrine tier — proof')
console.log('============================================================')

const { seatDoctrineTier } = await import('../../src/utils/model/seatSlots.js')
const { buildScribeAppend } = await import('../../src/utils/scribe/scribePack.js')
const { buildImplementerAppend } = await import('../../src/utils/scribe/implementerPack.js')

section('seatDoctrineTier classification')
check("claude-opus-5 ⇒ orchestrator (the D-02a implementer default)", seatDoctrineTier('claude-opus-5') === 'orchestrator')
check("claude-opus-4-8[1m] ⇒ orchestrator (selectable earlier Opus)", seatDoctrineTier('claude-opus-4-8[1m]') === 'orchestrator')
check("claude-opus-4-6 ⇒ orchestrator", seatDoctrineTier('claude-opus-4-6') === 'orchestrator')
check("claude-fable-5 ⇒ orchestrator", seatDoctrineTier('claude-fable-5') === 'orchestrator')
check("claude-mythos-5 ⇒ orchestrator (folds to fable)", seatDoctrineTier('claude-mythos-5') === 'orchestrator')
check("claude-sonnet-5 ⇒ executor", seatDoctrineTier('claude-sonnet-5') === 'executor')
check("claude-sonnet-4-6 ⇒ unknown (not a seat tier)", seatDoctrineTier('claude-sonnet-4-6') === 'unknown')
check("garbage ⇒ unknown", seatDoctrineTier('gpt-5') === 'unknown')

section('orchestrator slot ⇒ authored base append (byte-identical)')
const implBase = buildImplementerAppend({ workflows: false, lspEvidence: null, routed: false, executorSlot: false })
const implBase2 = buildImplementerAppend({ workflows: false, lspEvidence: null, routed: false, executorSlot: false })
check('builder is deterministic (two calls byte-identical)', implBase === implBase2)

section('executor slot ⇒ exactly the override blocks swapped, floors intact')
const implExec = buildImplementerAppend({ workflows: false, lspEvidence: null, routed: false, executorSlot: true })
check('executor append differs from base', implExec !== implBase)
const blocks = (a: string): string[] => a.split('\n\n')
const changed = blocks(implBase).filter((b, i) => blocks(implExec)[i] !== b)
check('implementer swap touches exactly 2 blocks (scope + style)', changed.length === 2 && blocks(implBase).length === blocks(implExec).length, `changed=${changed.length}`)
check('swapped doctrine present (escalate-early, no scope creep)', /escalating early is correct behavior/i.test(implExec) && /HARD boundary/.test(implExec))
check('floor sentence intact', /never overrides your always-on Mercury doctrine/.test(implExec))
const scribeBase = buildScribeAppend({ chatroom: false, routed: false, executorSlot: false })
const scribeExec = buildScribeAppend({ chatroom: false, routed: false, executorSlot: true })
const scribeChanged = blocks(scribeBase).filter((b, i) => blocks(scribeExec)[i] !== b)
check('scribe swap touches exactly 1 block (scope)', scribeChanged.length === 1 && blocks(scribeBase).length === blocks(scribeExec).length, `changed=${scribeChanged.length}`)
check('scribe swapped block is the scope doctrine', /refining front/.test(scribeChanged[0] ?? '') || /small reversible refinement calls stay yours/.test(scribeExec))

section('wiring (structural) — bridges pass the tier from the RESOLVED slot')
const sm = src('utils', 'scribeMode.ts')
const im = src('utils', 'implementerMode.ts')
check('scribeMode: executorSlot derives from seatDoctrineTier(resolveScribeSeatModel().model)', /const slotModel = resolveScribeSeatModel\(\)\.model[\s\S]{0,900}executorSlot: seatDoctrineTier\(slotModel\) === 'executor'/.test(sm))
check('implementerMode: executorSlot derives from seatDoctrineTier(seatModel)', /resolveImplementerSeat\(\)\.model[\s\S]{0,1400}executorSlot: seatDoctrineTier\(seatModel\) === 'executor'/.test(im))
check('caches documented input-keyed / slot-derived', /INPUT-KEYED/.test(im) && /slot-correct|slot is env-level process-stable/i.test(sm))

console.log('\n' + '='.repeat(60))
if (failures > 0) { console.log(` FAIL — ${failures} check(s) failed`); process.exit(1) }
console.log(' ALL SEAT-TIER PROOFS PASS')
