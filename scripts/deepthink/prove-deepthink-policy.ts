#!/usr/bin/env bun
// prove-deepthink-policy — the executable policy proof for the ALIGNED
// deepthink contract (P2, researched + aligned; the researched
// contract + citations live at src/utils/effort.ts, DEEPTHINK block).
//
//   §1 DETECTOR: \bdeepthink\b, case-insensitive, word-bounded — byte-parity
//      with the reference detector.
//   §2 PRODUCER (submission): keyword ⇒ exactly ONE bare
//      { type: 'deepthink_effort' } attachment — no level, no envPinned, no
//      other keys; the SKILL-body guard and keyword-less inputs produce [].
//   §3 PRODUCER (queued drain): the drained snapshot is scanned on its
//      PRE-expansion text — a queued keyword nudges, expanded content
//      containing the word does not (the ultraplan paste guard).
//   §4 NO WIRE EFFECT: the floor API is ABSENT from the module surface, and
//      isTurnOwningQuerySource (the surviving turn-owning scope) keeps its
//      polarity for the AUTOPILOT tier lifecycle.
//
// Hermetic: config home is a temp dir (no operator launchEffortUnpins bleed),
// effort-relevant env is scrubbed, MACRO simulates the stamped build.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'deepthink-policy-'))
delete process.env.MERCURY_EFFORT_LEVEL
delete process.env.USER_TYPE

// Fork-sim BEFORE importing (the build stamp reads MACRO.VERSION).
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const effortMod = await import('../../src/utils/effort.ts')
const { isTurnOwningQuerySource, getDisplayedEffortLevel } = effortMod
const { hasDeepthinkKeyword, isDeepthinkEnabled } = await import(
  '../../src/utils/thinking.ts'
)
const { getDeepthinkEffortAttachment } = await import(
  '../../src/utils/attachments/modeLifecycles.ts'
)

// Config reads (launch-pin lookups in getDefaultEffortForModel) are gated
// behind boot's enableConfigs(); flip it for the proof process.
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void =>
  console.log('\n' + '─'.repeat(76) + '\n' + t)

// A producer context stub: the aligned producer reads none of it (the
// parameter survives as a stable seam), so an empty object is honest.
const ctx = {} as never

section('§1 DETECTOR — reference byte-parity (\\bdeepthink\\b, /i)')
check('plain keyword', hasDeepthinkKeyword('please deepthink this'))
check('case-insensitive', hasDeepthinkKeyword('DEEPTHINK'))
check('word-bounded: deepthinking does NOT match', !hasDeepthinkKeyword('deepthinking hard'))
check('word-bounded: substring in identifier does NOT match', !hasDeepthinkKeyword('x.deepthinkMode'))
check('punctuation boundary matches', hasDeepthinkKeyword('finish it. deepthink.'))
check('enable gate is on', isDeepthinkEnabled() === true)

section('§2 PRODUCER — submission path: bare prose-nudge attachment only')
const hit = getDeepthinkEffortAttachment('go deepthink now', ctx)
check('keyword ⇒ exactly one attachment', hit.length === 1)
check('type is deepthink_effort', hit[0]?.type === 'deepthink_effort')
check(
  'attachment is BARE — no level/envPinned/extra keys',
  hit[0] !== undefined && Object.keys(hit[0]).length === 1,
  JSON.stringify(hit[0]),
)
check('no keyword ⇒ []', getDeepthinkEffortAttachment('just do the task', ctx).length === 0)
check('null input (mid-turn pass, no queue) ⇒ []', getDeepthinkEffortAttachment(null, ctx).length === 0)
check(
  'SKILL-body guard ⇒ [] even with keyword',
  getDeepthinkEffortAttachment('deepthink', ctx, { skipSkillDiscovery: true }).length === 0,
)

section('§3 PRODUCER — queued drain path: pre-expansion scan (paste guard)')
const qc = (over: Record<string, unknown>): never => over as never
check(
  'queued prompt with keyword (pre-expansion) ⇒ attachment',
  getDeepthinkEffortAttachment(null, ctx, undefined, [
    qc({ mode: 'prompt', preExpansionValue: 'deepthink and fix', value: 'expanded body' }),
  ] as never).length === 1,
)
check(
  'expanded content containing the word does NOT trigger (pre-expansion clean)',
  getDeepthinkEffortAttachment(null, ctx, undefined, [
    qc({ mode: 'prompt', preExpansionValue: 'run @notes.md', value: 'file says deepthink somewhere' }),
  ] as never).length === 0,
)
check(
  'non-prompt queue entries are ignored',
  getDeepthinkEffortAttachment(null, ctx, undefined, [
    qc({ mode: 'task-notification', preExpansionValue: 'deepthink' }),
  ] as never).length === 0,
)
check(
  'submission keyword still wins with a clean queue present',
  getDeepthinkEffortAttachment('deepthink', ctx, undefined, [
    qc({ mode: 'prompt', preExpansionValue: 'plain' }),
  ] as never).length === 1,
)

section('§4 NO WIRE EFFECT — the floor API is gone; scope helper polarity holds')
for (const dead of [
  'setTurnEffortFloor',
  'clearTurnEffortFloor',
  'getTurnEffortFloor',
  'applyTurnEffortFloor',
  'resolveDeepthinkTurnEffort',
  'deepthinkCeilingEnabled',
  'getDeepthinkFloorLevel',
  'compareEffortLevels',
]) {
  check(`effort module no longer exports ${dead}`, !(dead in effortMod))
}
check(
  'a keyword cannot move the displayed effort (no floor machinery to reach)',
  getDisplayedEffortLevel('claude-fable-5', 'medium') === 'medium',
)
check('repl_main_thread is turn-owning', isTurnOwningQuerySource('repl_main_thread'))
check('repl_main_thread:suffix is turn-owning', isTurnOwningQuerySource('repl_main_thread:x'))
check('sdk is turn-owning', isTurnOwningQuerySource('sdk'))
check('agent:sub is turn-owning', isTurnOwningQuerySource('agent:sub1'))
check('compact is NOT turn-owning', !isTurnOwningQuerySource('compact'))
check('undefined is NOT turn-owning', !isTurnOwningQuerySource(undefined))

console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} DEEPTHINK-POLICY PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL DEEPTHINK-POLICY PROOFS PASS')
