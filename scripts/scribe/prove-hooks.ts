#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-hooks.ts
//  PROOF: the
//  scribe/implementer keep-working discipline fires live through its REAL
//  register/engage path (not a reimpl) — since the move a typed TURN-ENGINE
//  settlement effect (query/settlementEffects.ts), evaluated through the
//  same runTurnSettlementEffects seam handleStopHooks phase 4b calls:
//  engaging arms the per-session effect with a per-TURN loop-brake (blocks
//  an unfinished tail until maxBlocks, then allows), allows a finished
//  tail, disengage removes it, and re-engage is idempotent. User-authored
//  hooks keep their own registry untouched (law 3).
//
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-hooks.ts
// ============================================================================

import { join } from 'node:path'
const ROOT = join(import.meta.dir, '..', '..')
import { readdirSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { AppState } from '../../src/state/AppState.js'
import type { Message } from '../../src/types/message.js'
import { _resetContinuationLatchesForTesting } from '../../src/services/run/continuationLatch.js'
import { getSessionFunctionHooks } from '../../src/utils/hooks/sessionHooks.js'
import {
  isTurnSettlementEffectEngaged,
  runTurnSettlementEffects,
} from '../../src/query/settlementEffects.js'
import {
  IMPLEMENTER_STOP_HOOK_ID,
  SCRIBE_STOP_HOOK_ID,
} from '../../src/utils/hooks/scribeImplementerStopHook.js'
import {
  engageImplementerHooks,
  disengageImplementerHooks,
  areImplementerHooksEngaged,
  engageScribeHooks,
  disengageScribeHooks,
  areScribeHooksEngaged,
} from '../../src/utils/hooks/scribeImplementerHooks.js'
import {
  assertSingleRole,
  isScribeRole,
  isImplementerRole,
} from '../../src/utils/scribe/scribeGates.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
function srcText(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8')
}

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
function makeState(): { state: AppState; setAppState: (u: (p: AppState) => AppState) => void } {
  let state = { sessionHooks: new Map() } as unknown as AppState
  return { state, setAppState: u => { state = u(state) } }
}
// The REAL consumer seam: handleStopHooks phase 4b calls
// runTurnSettlementEffects(sessionId, {messages}) and re-prompts with each
// 'continue' decision — evaluating through the same seam proves the wiring,
// not a reimplementation. `true` = settled; a string = the block's re-prompt.
function settleThrough(sid: string) {
  return async (messages: Message[]): Promise<true | string> => {
    const { reprompts } = await runTurnSettlementEffects(sid, { messages })
    return reprompts.length === 0 ? true : reprompts[0]!
  }
}
function hasStopEffect(sid: string, id: string): boolean {
  return isTurnSettlementEffectEngaged(sid, id)
}
const assistant = (text: string): Message =>
  ({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) as unknown as Message

const unfinished = [assistant('Recon done.\n\nI\'ll wire up the dispatch next.')]
const finished = [assistant('Dispatched the task.\n\nGreen-gate passing. STATUS: done.')]
// (runStopAdapter): a BLOCK may return `false` OR the documented
// dynamic-string re-prompt (FunctionHookCallback contract). Distinct stop
// attempts must have distinct transcripts (the continuation latch treats an
// identical transcript as the SAME attempt — production shape: each blocked
// stop grows the transcript by the model's next try).
const blocksStop = (r: unknown): boolean => r === false || typeof r === 'string'
const unfinished2 = [...unfinished, assistant("Still pending.\n\nI'll wire up the dispatch next.")]
const unfinished3 = [...unfinished2, assistant("Almost.\n\nI'll wire up the dispatch next.")]
const unfinished4 = [...unfinished3, assistant("One more.\n\nI'll wire up the dispatch next.")]

console.log('============================================================')
console.log(' Scribe/Implementer keep-working hooks — Phase-2 Task 2.3 proof')
console.log('============================================================')

setStamp(true)

section('Implementer effect — engage / block / loop-brake / disengage / idempotent')
{
  const { setAppState } = makeState()
  check('engageImplementerHooks() returns true (installed)', engageImplementerHooks(setAppState, 'impl-1') === true)
  check("areImplementerHooksEngaged('impl-1') true after engage (session-keyed)", areImplementerHooksEngaged('impl-1') === true)
  check('the keep-working settlement effect is engaged', hasStopEffect('impl-1', IMPLEMENTER_STOP_HOOK_ID))
  check('re-engage is idempotent (returns false, no duplicate)', engageImplementerHooks(setAppState, 'impl-1') === false)

  const cb = settleThrough('impl-1')
  _resetContinuationLatchesForTesting()
  check('ALLOWS stop on a finished status tail', (await cb(finished)) === true)
  check('BLOCKS stop on an unfinished tail (1)', blocksStop(await cb(unfinished)))
  check('BLOCKS stop on an unfinished tail (2)', blocksStop(await cb(unfinished2)))
  check('BLOCKS stop on an unfinished tail (3)', blocksStop(await cb(unfinished3)))
  check('LOOP-BRAKE: allows stop after maxBlocks (3) reached', (await cb(unfinished4)) === true)

  check('disengageImplementerHooks() returns true', disengageImplementerHooks(setAppState, 'impl-1') === true)
  check("areImplementerHooksEngaged('impl-1') false after disengage", areImplementerHooksEngaged('impl-1') === false)
  check('the settlement effect was removed', !hasStopEffect('impl-1', IMPLEMENTER_STOP_HOOK_ID))
  check('re-engage after disengage returns true (fresh)', engageImplementerHooks(setAppState, 'impl-1') === true)
  disengageImplementerHooks(setAppState, 'impl-1')
}

section('Scribe effect — engage / disengage (+ the dispatch gate stays a PreToolUse hook)')
{
  const { state, setAppState } = makeState()
  check('engageScribeHooks() returns true', engageScribeHooks(setAppState, 'scribe-1') === true)
  check("areScribeHooksEngaged('scribe-1') true (session-keyed)", areScribeHooksEngaged('scribe-1') === true)
  check('the keep-working settlement effect is engaged', hasStopEffect('scribe-1', SCRIBE_STOP_HOOK_ID))
  // The source dispatch-gate is a TOOL-time gate, not settle-time — it
  // deliberately stays a PreToolUse function hook (named boundary of the
  // settlement-effects move).
  check(
    'the dispatch gate still registers as a PreToolUse hook',
    getSessionFunctionHooks(state, 'scribe-1', 'PreToolUse').size > 0,
  )
  const cb = settleThrough('scribe-1')
  _resetContinuationLatchesForTesting()
  check('Scribe effect BLOCKS an unfinished tail', blocksStop(await cb(unfinished)))
  check('Scribe effect ALLOWS a finished tail', (await cb(finished)) === true)
  check('disengageScribeHooks() returns true', disengageScribeHooks(setAppState, 'scribe-1') === true)
  check('settlement effect removed', !hasStopEffect('scribe-1', SCRIBE_STOP_HOOK_ID))
}

// hooks engage stamp-independently.
section('bare stamp ⇒ engage STILL works (stamp-independence)')
{
  setStamp(false)
  const { setAppState } = makeState()
  check('engageImplementerHooks() returns true under a bare stamp', engageImplementerHooks(setAppState, 'nf') === true)
  check('settlement effect engaged under a bare stamp', hasStopEffect('nf', IMPLEMENTER_STOP_HOOK_ID))
  check('disengage cleans up (leave no residue for later sections)', disengageImplementerHooks(setAppState, 'nf') === true && !hasStopEffect('nf', IMPLEMENTER_STOP_HOOK_ID))
  setStamp(true)
}

// ── ISSUE 1: SILENT keep-working delivery ───────────────────────────────────
// The re-prompt must reach the MODEL (isMeta user message) but be hidden from
// the front-end transcript — no "Stop hook error" summary line, no
// notification. Since the settlement-effects move the delivery is the
// ENGINE's own (stopHooks.ts phase 4b): a meta user message per 'continue'
// decision, with no hookErrors push and no notification in that phase —
// silent BY CONSTRUCTION. stopHooks.ts is unloadable under bun-run
// (color-diff-napi), so the phase is pinned structurally.
section('ISSUE 1 — the engine settlement delivery is silent by construction')
{
  const sh = srcText('src/query/stopHooks.ts')
  check(
    'phase 4b evaluates the engine settlement effects (runTurnSettlementEffects)',
    /runTurnSettlementEffects\(String\(getSessionId\(\)\)/.test(sh),
  )
  check(
    "phase 4b delivers each re-prompt as a META user message",
    /for \(const reprompt of settlement\.reprompts\) \{[\s\S]*?createUserMessage\(\{ content: reprompt, isMeta: true \}\)/.test(sh),
  )
  check(
    'phase 4b runs on the MAIN thread only (the Stop event the hooks rode)',
    /const settlementBlocks: UserMessage\[\] = \[\][\s\S]{0,4}if \(!agentId\) \{/.test(sh),
  )
  check(
    'phase 4b never touches hookErrors or notifications (no visible summary)',
    !/settlement\.reprompts[\s\S]{0,400}hookErrors\.push/.test(sh),
  )
}

section('ISSUE 1 — structural: consumer suppresses visible summary but keeps the model nudge')
{
  const sh = srcText('src/query/stopHooks.ts')
  // (Pins trued to the consumeHookStream spellings — the pre-restructure
  // regexes had gone stale against the file and failed on base.)
  // The isMeta user message (model-facing re-prompt) is STILL pushed+yielded.
  check('stopHooks still pushes the isMeta user message (model gets the nudge)', /blockingErrors\.push\(message\)/.test(sh) && /yield message/.test(sh))
  // A USER function hook's silent flag still suppresses the visible summary
  // (the machinery remains for the user's own hooks; the product's
  // keep-working effects no longer ride it).
  check('stopHooks reads blockingError.silent for the visible-summary gate', /\(blockingError as \{ silent\?: boolean \}\)\.silent/.test(sh))
  check('hookErrors.push is gated behind the silent check', /if \(!\(blockingError as \{ silent\?: boolean \}\)\.silent\) \{[\s\S]*?hookErrors\.push\(blockingError\.blockingError\)/.test(sh))
  // The error notification fires only when hookErrors is non-empty — so suppressing
  // the push also suppresses the notification.
  check('error notification fires only when hookErrors.length > 0', /if\s*\(hookErrors\.length\s*>\s*0\)\s*\{[\s\S]*?addNotification/.test(sh))

  // The keep-working semantics no longer ride the user's hook registry at
  // all: the two role modules register ENGINE settlement effects and never
  // call addFunctionHook for Stop (law 3 — the product stopped shipping its
  // own logic as hooks).
  const si = srcText('src/utils/hooks/scribeImplementerStopHook.ts')
  check('scribeImplementerStopHook engages a settlement effect (no Stop function hook)', /engageTurnSettlementEffect/.test(si) && !/addFunctionHook/.test(si))
  // The FunctionHook type + addFunctionHook options carry silent through.
  const sess = srcText('src/utils/hooks/sessionHooks.ts')
  check('FunctionHook type has silent?: boolean', /silent\?:\s*boolean/.test(sess))
  check('addFunctionHook plumbs options.silent onto the hook', /silent:\s*options\?\.silent/.test(sess))
  // executeFunctionHook copies hook.silent onto the returned blockingError.
  // R4 module-scoped read: the hooks engine is splitting into
  // owned submodules; these invariants are module-scoped.
  const hooks = srcText('src/utils/hooks.ts') + readdirSync(join(ROOT, 'src/utils/hooks')).filter(f => f.endsWith('.ts')).map(f => srcText(`src/utils/hooks/${f}`)).join('\n')
  check('executeFunctionHook copies hook.silent onto blockingError', /silent:\s*hook\.silent/.test(hooks))
  check('HookBlockingError type has silent?: boolean', /interface HookBlockingError[\s\S]*?silent\?:\s*boolean/.test(hooks))
}

// ── ISSUE 2: role purity — exactly ONE keep-working hook per process ─────────
section('ISSUE 2 — assertSingleRole + role-pure engagers (no in-process cross-role leak)')
{
  const SCRIBE = 'MERCURY_SCRIBE'
  const IMPL = 'MERCURY_IMPLEMENTER'
  const saveS = process.env[SCRIBE]
  const saveI = process.env[IMPL]
  const restore = () => {
    if (saveS === undefined) delete process.env[SCRIBE]; else process.env[SCRIBE] = saveS
    if (saveI === undefined) delete process.env[IMPL]; else process.env[IMPL] = saveI
  }

  // (a) both roles set ⇒ assertSingleRole throws
  process.env[SCRIBE] = '1'
  process.env[IMPL] = '1'
  check('isScribeRole() && isImplementerRole() both true when both env set', isScribeRole() && isImplementerRole())
  let threw = false
  try { assertSingleRole() } catch { threw = true }
  check('assertSingleRole() THROWS when a process is tagged both roles', threw)

  // (a2) both-roles engage also aborts (assertSingleRole runs first inside engage)
  {
    const { setAppState } = makeState()
    let engageThrew = false
    try { engageScribeHooks(setAppState, 'both-1') } catch { engageThrew = true }
    check('engageScribeHooks() aborts (throws) when both roles set', engageThrew)
    check('no settlement effect engaged after the aborted both-roles engage', !hasStopEffect('both-1', SCRIBE_STOP_HOOK_ID))
  }

  // (b) only the OTHER role set ⇒ engager refuses (returns false), registers nothing
  process.env[SCRIBE] = '1'
  delete process.env[IMPL]
  {
    const { setAppState } = makeState()
    check('engageImplementerHooks() REFUSES (false) in a Scribe-role process', engageImplementerHooks(setAppState, 'pure-1') === false)
    check('no Implementer effect leaked into the Scribe process', !hasStopEffect('pure-1', IMPLEMENTER_STOP_HOOK_ID))
    // The matching role still engages exactly one keep-working effect.
    check('engageScribeHooks() succeeds in a Scribe-role process', engageScribeHooks(setAppState, 'pure-1') === true)
    check('exactly ONE keep-working effect engaged (the Scribe effect)', hasStopEffect('pure-1', SCRIBE_STOP_HOOK_ID) && !hasStopEffect('pure-1', IMPLEMENTER_STOP_HOOK_ID))
    disengageScribeHooks(setAppState, 'pure-1')
  }

  delete process.env[SCRIBE]
  process.env[IMPL] = '1'
  {
    const { setAppState } = makeState()
    check('engageScribeHooks() REFUSES (false) in an Implementer-role process', engageScribeHooks(setAppState, 'pure-2') === false)
    check('no Scribe effect leaked into the Implementer process', !hasStopEffect('pure-2', SCRIBE_STOP_HOOK_ID))
    check('engageImplementerHooks() succeeds in an Implementer-role process', engageImplementerHooks(setAppState, 'pure-2') === true)
    check('exactly ONE keep-working effect engaged (the Implementer effect)', hasStopEffect('pure-2', IMPLEMENTER_STOP_HOOK_ID) && !hasStopEffect('pure-2', SCRIBE_STOP_HOOK_ID))
    disengageImplementerHooks(setAppState, 'pure-2')
  }

  restore()

  // Structural: QueryEngine calls assertSingleRole before the engage block.
  const qe = srcText('src/QueryEngine.ts')
  check('QueryEngine imports assertSingleRole', /import\s*\{\s*assertSingleRole\s*\}\s*from\s*'\.\/utils\/scribe\/scribeGates\.js'/.test(qe))
  check('QueryEngine calls assertSingleRole() before the engage block', /assertSingleRole\(\)[\s\S]*?if\s*\(isScribeModeOn\(\)\)/.test(qe))
  const sih = srcText('src/utils/hooks/scribeImplementerHooks.ts')
  check('engageScribeHooks refuses when isImplementerRole()', /isImplementerRole\(\)/.test(sih))
  check('engageImplementerHooks refuses when isScribeRole()', /isScribeRole\(\)/.test(sih))
}

setStamp(false)
console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL SCRIBE-HOOK PROOFS PASS')
else console.log(`❌ ${failures} SCRIBE-HOOK PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
