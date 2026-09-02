#!/usr/bin/env bun
// ============================================================================
//  scripts/pulse/matrix/prove-first-turn-hooks-counted.ts — first-turn hook
//  waits are INSIDE total latency.
//
//  STATUS: LIVE — needs the MERCURY_PULSE_DUMP seam;
//  exits 2 (PENDING-INTEGRATION) only if the seam leaves the artifact.
//
//  The old defect: REPL awaited pending SessionStart hooks BEFORE
//  handlePromptSubmit while profiling began inside it — the first-turn hook
//  wait was invisible. The law: scene 2 (a sleep-8 SessionStart hook still
//  running at the 5.6s submit) must show a pending_session_hooks stage in
//  the trace, of real duration, that ends before actual dispatch and is
//  therefore included in the submit→dispatch span (localPrepMs).
//
//  Scene 3 (sleep-2 UserPromptSubmit) pins the same law for prompt hooks.
//
//  Run:  ~/.bun/bin/bun run scripts/pulse/matrix/prove-first-turn-hooks-counted.ts
// ============================================================================

import { check, section, finish, requireDistSeam, armWatchdog } from '../lib/proveKit.ts'
import { sceneByKey, runScene } from './scenes.ts'

// NB: stage events are composed at runtime (`${stage}_start`) — gate on the
// stage-name literal, which lives in the bundle at the call site.
requireDistSeam('MERCURY_PULSE_DUMP', 'prove-first-turn-hooks-counted')
requireDistSeam('pending_session_hooks', 'prove-first-turn-hooks-counted')
armWatchdog('PULSE first-turn hooks counted', 180_000)

const sessionStart = await runScene(sceneByKey('hook-session-start'))
const promptSubmit = await runScene(sceneByKey('hook-prompt-submit'))

function at(line: { events: { name: string; at: number }[] }, name: string): number | null {
  const e = line.events.find(ev => ev.name === name)
  return e ? e.at : null
}

section('scene 2 — delayed SessionStart hook counted in the first turn')
{
  check('one dump line', sessionStart.pulse.length === 1, String(sessionStart.pulse.length))
  const line = sessionStart.pulse[0]!
  const start = at(line, 'pending_session_hooks_start')
  const end = at(line, 'pending_session_hooks_end')
  const submit = at(line, 'submit_received')
  const sent = at(line, 'api_request_sent')
  check('pending_session_hooks stage present', start !== null && end !== null)
  if (start !== null && end !== null && submit !== null && sent !== null) {
    check(
      'the hook wait is REAL (stage ≥ 1000ms)',
      end - start >= 1000,
      `${Math.round(end - start)}ms`,
    )
    check('the stage opens after submit_received', start >= submit)
    check('…and closes before actual dispatch', end <= sent)
    const localPrep = line.summary.localPrepMs
    check(
      'localPrepMs (submit→dispatch) contains the wait',
      typeof localPrep === 'number' && localPrep >= end - start,
      `localPrep=${localPrep}ms stage=${Math.round(end - start)}ms`,
    )
  }
  check('the turn still completes', line.summary.status === 'complete')
}

section('scene 3 — delayed UserPromptSubmit hook counted')
{
  check('one dump line', promptSubmit.pulse.length === 1, String(promptSubmit.pulse.length))
  const line = promptSubmit.pulse[0]!
  const start = at(line, 'user_prompt_hooks_start')
  const end = at(line, 'user_prompt_hooks_end')
  const sent = at(line, 'api_request_sent')
  check('user_prompt_hooks stage present', start !== null && end !== null)
  if (start !== null && end !== null && sent !== null) {
    check(
      'the sleep-2 hook wait is inside the stage (≥1800ms)',
      end - start >= 1800,
      `${Math.round(end - start)}ms`,
    )
    check('the stage closes before actual dispatch', end <= sent)
    const localPrep = line.summary.localPrepMs
    check(
      'localPrepMs contains the wait',
      typeof localPrep === 'number' && localPrep >= end - start,
      `localPrep=${localPrep}ms`,
    )
  }
  check('the turn still completes', line.summary.status === 'complete')
}

sessionStart.cleanup()
promptSubmit.cleanup()
finish('PULSE first-turn hooks counted')
