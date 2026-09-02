#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-agent-classifier.ts
//  PROOF: the per-turn agent-state classifier is WIRED LIVE — the
//  zero-token heuristic tier ships ON (opt out MERCURY_AGENT_CLASSIFIER=0), and
//  the heuristic correctly raises a needs-attention signal. Exercised against
//  the REAL production code (agentStateClassifier + agentStateHeuristic).
// ============================================================================

// Import from the import-light heuristic module (no model/SDK/query-stack deps).
import {
  agentStateClassifierEnabled,
  classifyAgentStateHeuristic,
  tempoForState,
} from '../../src/services/agentStateHeuristic.js'

let failures = 0
function check(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}

console.log('============================================================')
console.log(' Agent-state classifier — WIRED LIVE proof')
console.log('============================================================')

section('Gate — heuristic tier default-on, opt out =0 (stamp-independent )')
setStamp(false)
delete process.env.MERCURY_AGENT_CLASSIFIER
check('bare stamp, unset ⇒ STILL on (stamp-independence)', agentStateClassifierEnabled() === true)
process.env.MERCURY_AGENT_CLASSIFIER = '1'
check('bare stamp, =1 ⇒ on (explicit enable works anywhere)', agentStateClassifierEnabled() === true)
setStamp(true)
delete process.env.MERCURY_AGENT_CLASSIFIER
check('fork, unset ⇒ LIVE by default', agentStateClassifierEnabled() === true)
process.env.MERCURY_AGENT_CLASSIFIER = '0'
check('fork, =0 ⇒ off (explicit opt-out)', agentStateClassifierEnabled() === false)
delete process.env.MERCURY_AGENT_CLASSIFIER

section('Heuristic — zero-token classification raises needs-attention')
{
  const blocked = classifyAgentStateHeuristic('I added the gate. Which approach would you like me to take next?')
  check('a trailing question ⇒ blocked', blocked?.state === 'blocked')
  check('blocked ⇒ tempo blocked (needs attention)', blocked?.tempo === 'blocked')
  check('blocked carries a needs note', typeof blocked?.needs === 'string' && (blocked?.needs?.length ?? 0) > 0)

  const failed = classifyAgentStateHeuristic('I ran the build but it failed with an error I could not resolve.')
  check('error/inability language ⇒ failed', failed?.state === 'failed')
  check('failed ⇒ tempo blocked (needs attention)', failed?.tempo === 'blocked')

  const done = classifyAgentStateHeuristic('Done — I implemented the feature and all tests pass. Successfully finished.')
  check('completion language ⇒ done', done?.state === 'done')
  check('done ⇒ tempo idle (no attention needed)', done?.tempo === 'idle')

  const working = classifyAgentStateHeuristic('Reading the config file and tracing the gate consumers across the tree.')
  check('mid-task prose ⇒ working', working?.state === 'working')
  check('working ⇒ tempo active', working?.tempo === 'active')

  check('empty text ⇒ null (no verdict)', classifyAgentStateHeuristic('   ') === null)
  check('tempoForState maps failed→blocked', tempoForState('failed') === 'blocked')
}

section('Heuristic — recency weighting fixes the verified false-positives')
{
  // (a) "fixed the error … done" must NOT classify as failed just because the
  //     word "error" appears earlier in the turn.
  const fixedThenDone = classifyAgentStateHeuristic('Fixed the error. All tests pass. Done.')
  check('"Fixed the error … Done." ⇒ done (not failed)', fixedThenDone?.state === 'done')
  check('done ⇒ tempo idle (no false needs-attention)', fixedThenDone?.tempo === 'idle')

  // multi-line variant: error in an earlier line, done on the last line.
  const multiline = classifyAgentStateHeuristic('Hit an exception in the parser.\nResolved it.\nAll done.')
  check('multi-line "exception … resolved … all done" ⇒ done', multiline?.state === 'done')

  // (b) a question that also mentions an inability must classify as blocked, not failed.
  const couldNotQuestion = classifyAgentStateHeuristic('I could not find the file. Which path should I use?')
  check('"could not … which path?" ⇒ blocked (not failed)', couldNotQuestion?.state === 'blocked')
  check('blocked ⇒ tempo blocked (needs attention)', couldNotQuestion?.tempo === 'blocked')

  // a genuine failure on the last line is still caught (no over-correction).
  const genuineFail = classifyAgentStateHeuristic('I implemented the parser.\nThe build failed with a type error I could not fix.')
  check('genuine trailing failure still ⇒ failed', genuineFail?.state === 'failed')

  // fix-language alone on the last line negates the failure word.
  const fixedAlone = classifyAgentStateHeuristic('The crash is fixed now.')
  check('"fixed now" is not a failure', fixedAlone?.state !== 'failed')
}

setStamp(false)
delete process.env.MERCURY_AGENT_CLASSIFIER

// ── Store lifecycle + the rising-edge clear ────────────────────
// The "▲ agent needs you" chip stayed alarming through a whole working turn:
// the classifier fires only on the turn-END edge, and clearAgentStateVerdict
// had ZERO callers. The fix clears on the turn-START edge; this section pins
// (a) the store round-trip and (b) the hook's rising-edge clear, structurally.
section('Store lifecycle — record → read → CLEAR → gone')
{
  const store = await import('../../src/services/agentStateClassifier.js')
  const sid = 'prove-agent-classifier-session'
  store.recordAgentStateVerdict(sid, {
    state: 'blocked',
    tempo: 'blocked',
    detail: 'q',
    needs: 'answer the question / provide input',
  } as never)
  check('recorded verdict is readable', store.getAgentStateVerdict(sid)?.verdict.tempo === 'blocked')
  store.clearAgentStateVerdict(sid)
  check('clearAgentStateVerdict wipes it (snapshot goes unavailable)', store.getAgentStateVerdict(sid) == null)

  const { readFileSync } = await import('node:fs')
  const hook = readFileSync(
    new URL('../../src/hooks/useAgentStateClassifier.ts', import.meta.url),
    'utf8',
  )
  check(
    'the hook CLEARS on the loading false→true edge (the stale-chip fix)',
    /if \(!wasLoading && isLoading\) \{[\s\S]{0,240}?clearAgentStateVerdict\(getSessionId\(\)\)/.test(hook),
  )
  check('the rising edge also aborts an in-flight classify', /if \(!wasLoading && isLoading\) \{[\s\S]{0,120}?abortRef\.current\?\.abort\(\)/.test(hook))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL AGENT-CLASSIFIER PROOFS PASS')
else console.log(`❌ ${failures} AGENT-CLASSIFIER PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
