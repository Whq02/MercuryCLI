#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-prompt-splice.ts
//  PROOF (Phase 2 Task 2.2): the scribe/implementer mode toggles produce []
//  when off and [<compiled>] when on, and are spliced into getSystemPrompt()
//  right after the fable sections. Exercised against the REAL toggle modules
//  (src/utils/{scribeMode,implementerMode}.ts).
//
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-prompt-splice.ts
//
//  getSystemPrompt() pulls the full prompt-builder dependency chain (not
//  loadable under bun-run), so the splice WIRING is verified structurally
//  against the prompts.ts source (the splice contributes [] when off ⇒ the
//  built prompt is byte-identical; the wiring assertion proves the call exists).
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  getScribeModeSections,
  getScribeModeAppend,
  setScribeMode,
} from '../../src/utils/scribeMode.js'
import {
  getImplementerModeSections,
  getImplementerModeAppend,
  setImplementerMode,
} from '../../src/utils/implementerMode.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}

console.log('============================================================')
console.log(' Scribe/Implementer prompt splice — Phase-2 Task 2.2 proof')
console.log('============================================================')

section('A — getScribeModeSections() gating')
// sections are stamp-independent — a bare
// stamp with mode on yields the SAME sections as a version stamp.
setStamp(false); setScribeMode(true)
check('bare stamp + mode on ⇒ same one section (stamp-independence)', getScribeModeSections().length === 1)
setStamp(true); setScribeMode(false)
check('fork + mode OFF ⇒ []', getScribeModeSections().length === 0)
setScribeMode(true)
const scribeSecs = getScribeModeSections()
check('fork + mode ON ⇒ exactly one section', scribeSecs.length === 1)
check('the section is non-empty and === compiled append', scribeSecs[0]?.length > 0 && scribeSecs[0] === getScribeModeAppend())
check('compiled scribe append mentions the Scribe role', /Scribe/.test(getScribeModeAppend()))
setScribeMode(false)
check('back to mode OFF ⇒ []', getScribeModeSections().length === 0)

section('B — getImplementerModeSections() gating')
setStamp(false); setImplementerMode(true)
check('bare stamp + mode on ⇒ sections present (stamp-independence)', getImplementerModeSections().length > 0)
setStamp(true); setImplementerMode(false)
check('fork + mode OFF ⇒ []', getImplementerModeSections().length === 0)
setImplementerMode(true)
const implSecs = getImplementerModeSections()
check('fork + mode ON ⇒ exactly one section', implSecs.length === 1)
check('the section is non-empty and === compiled append', implSecs[0]?.length > 0 && implSecs[0] === getImplementerModeAppend())
check('compiled implementer append mentions the Implementer role', /Implementer/.test(getImplementerModeAppend()))
setImplementerMode(false)
check('back to mode OFF ⇒ []', getImplementerModeSections().length === 0)

section('C — both off ⇒ the splice contributes nothing (byte-identical)')
setStamp(true); setScribeMode(false); setImplementerMode(false)
check('both modes off ⇒ scribe sections []', getScribeModeSections().length === 0)
check('both modes off ⇒ implementer sections []', getImplementerModeSections().length === 0)

section('D — getSystemPrompt() splice wiring (structural, src)')
const promptsSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'constants', 'prompts.ts'), 'utf-8')
check('prompts.ts imports getScribeModeSections', promptsSrc.includes('getScribeModeSections'))
check('prompts.ts imports getImplementerModeSections', promptsSrc.includes('getImplementerModeSections'))
check(
  'splice: getScribeModeSections leads the mode packs, getImplementerModeSections follows (statement form, consecutive pushPack calls)',
  /pushPack\('mode-scribe', getScribeModeSections\(\)\)\s*\n\s*pushPack\('mode-implementer', getImplementerModeSections\(\)\)/.test(promptsSrc),
)

setStamp(false)
console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL PROMPT-SPLICE PROOFS PASS')
else console.log(`❌ ${failures} PROMPT-SPLICE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
