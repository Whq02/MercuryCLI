#!/usr/bin/env bun
// ============================================================================
//  scripts/model-routing/prove-stream-fault-recovery.ts — G5: the bounded
//  continuation for the CONTINUABLE stream-fault class (fault AFTER partial
//  content). Admitted on measured evidence: 3 faults / 10 Sol-lane runs
//  across+Glassbird; a last-turn fault became the whole headless
//  result (the before-state, retained in the comparison envelope).
//
//  Laws proved:
//    1. the typed marker + composer + classifier agree (producer can't drift);
//    2. BOTH provider transports compose their fault tail through the shared
//       composer (source pin — the sibling class is complete);
//    3. the pure recovery decision: ONE continuation, then surface; a
//       non-continuable tail never continues;
//    4. the turn machine wires the continuation BEFORE the terminal
//       API-error branch, injects an isMeta nudge, increments the bound, and
//       the transition reason is typed (source pins on the wiring; the pure
//       decision carries the behavior).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  API_ERROR_MESSAGE_PREFIX,
  STREAM_FAULT_AFTER_PARTIAL_MARKER,
  isContinuableStreamFaultMessage,
  streamFaultAfterPartialText,
} from '../../src/services/api/errors.js'
import { createAssistantAPIErrorMessage } from '../../src/utils/messages.js'

const repoRoot = resolve(new URL('../..', import.meta.url).pathname)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

// ── 1 · marker + composer + classifier ──────────────────────────────────────
{
  const text = streamFaultAfterPartialText('OpenAI', 'openai-stream-error', 'terminated')
  check('composer carries the API error prefix', text.startsWith(API_ERROR_MESSAGE_PREFIX))
  check('composer carries the marker', text.includes(STREAM_FAULT_AFTER_PARTIAL_MARKER))
  const faultTail = createAssistantAPIErrorMessage({ content: text, error: 'unknown' })
  check('classifier accepts the composed tail', isContinuableStreamFaultMessage(faultTail))
  const rateLimit = createAssistantAPIErrorMessage({
    content: `${API_ERROR_MESSAGE_PREFIX}: rate limited`,
    error: 'unknown',
  })
  check('classifier rejects other API errors', !isContinuableStreamFaultMessage(rateLimit))
  const nonError = createAssistantAPIErrorMessage({ content: text, error: 'unknown' })
  nonError.isApiErrorMessage = false
  check('classifier requires the API-error flag', !isContinuableStreamFaultMessage(nonError))
}

// ── 2 · both transports ride the shared composer (sibling class complete) ───
{
  for (const file of [
    'src/services/providers/openai/openaiCallModel.ts',
    'src/services/providers/zai/zaiCallModel.ts',
  ]) {
    const source = readFileSync(resolve(repoRoot, file), 'utf8')
    check(file + ' composes via streamFaultAfterPartialText', source.includes('streamFaultAfterPartialText('))
    check(
      file + ' has no hand-rolled after-partial tail left',
      !source.includes("stream fault after partial content ("),
    )
  }
}

// ── 3 · the pure decision ────────────────────────────────────────────────────
{
  const { decideStreamFaultRecovery } = await import('../../src/run-core/turn-machine.js')
  const first = decideStreamFaultRecovery({ continuableTail: true, recoveryCount: 0 })
  check('first fault continues (attempt 1)', first.kind === 'continue' && first.attempt === 1)
  const second = decideStreamFaultRecovery({ continuableTail: true, recoveryCount: 1 })
  check('second fault surfaces (bound = 1 per run)', second.kind === 'surface')
  const other = decideStreamFaultRecovery({ continuableTail: false, recoveryCount: 0 })
  check('non-continuable tails never continue', other.kind === 'surface')
}

// ── 4 · wiring pins ──────────────────────────────────────────────────────────
{
  const source = readFileSync(resolve(repoRoot, 'src/run-core/turn-machine.ts'), 'utf8')
  const continuation = source.indexOf('isContinuableStreamFaultMessage(lastMessage)')
  const terminal = source.indexOf('if (lastMessage?.isApiErrorMessage) {')
  check('continuation branch sits BEFORE the terminal API-error branch', continuation > 0 && terminal > continuation)
  // the nudge prose moved to its owner (STREAM_FAULT_RECOVERY_NUDGE
  // in services/api/errors.ts — the transcript classifies "recovered" by it);
  // the turn machine composes through the constant. Same law, owned needle.
  check('the nudge is meta (never rendered as operator input)', /content: STREAM_FAULT_RECOVERY_NUDGE[\s\S]{0,200}isMeta: true/.test(source))
  check('the nudge prose lives at its owner', readFileSync(resolve(repoRoot, 'src/services/api/errors.ts'), 'utf8').includes("'The provider stream dropped mid-response after partial content. '"))
  check('the bound increments into the next state', source.includes('streamFaultRecoveryCount: streamFaultRecoveryCount + 1'))
  const transitions = readFileSync(resolve(repoRoot, 'src/query/transitions.ts'), 'utf8')
  check('the transition reason is typed', transitions.includes("reason: 'stream_fault_recovery'; attempt: number"))
}

if (failures > 0) {
  console.error('prove-stream-fault-recovery: RED (' + failures + ')')
  process.exit(1)
}
console.log('prove-stream-fault-recovery: green')
