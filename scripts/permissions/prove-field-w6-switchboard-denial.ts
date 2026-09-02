#!/usr/bin/env bun
// ============================================================================
//  scripts/permissions/prove-field-w6-switchboard-denial.ts
//  TASK-018 wave 6 (interrupt-and-cancel) — a permission denied through the
//  daemon switchboard now reads AS a denial everywhere.
//
//  The daemon minted its own sentence, "denied from the switchboard by
//  <by>", and the expiry/eviction path minted another. Neither matched any
//  clause of isDenialResultText, so the operator's own No wore the amber
//  "ordinary failure" lead the product reserves for a failing command, the
//  model was told none of the STOP guidance the canon carries, and the
//  identical-failure guard did not exempt a repeated operator veto. The fix
//  builds the model-facing denial from the canon (REJECT_MESSAGE /
//  REJECT_MESSAGE_WITH_REASON_PREFIX), exactly as the in-process path does,
//  and words the expiry/eviction denial so the classifier reads it too.
//
//  Pure string classification + source anchor — no vendored regex, no daemon
//  graph imported. Runs the same under bun or node.
//  Run: ~/.bun/bin/bun run scripts/permissions/prove-field-w6-switchboard-denial.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DENIAL_WORKAROUND_GUIDANCE,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
  isDenialResultText,
} from '../../src/utils/messages/rejectionText.js'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('§1 — the canon the daemon now emits classifies as a DENIAL')
check('bare operator No → REJECT_MESSAGE classifies', isDenialResultText(REJECT_MESSAGE))
check(
  'operator No with feedback → REJECT_MESSAGE_WITH_REASON_PREFIX classifies',
  isDenialResultText(REJECT_MESSAGE_WITH_REASON_PREFIX + 'use the Read tool instead'),
)

console.log('§2 — the expiry/eviction denial, worded like the fix, classifies')
// The shape src/daemon/permissionAsks.ts:expiredAskDenialMessage now builds.
const expired = `Permission to use Bash has been denied: nobody answered the permission ask within 5m, so it expired. ${DENIAL_WORKAROUND_GUIDANCE}`
const evicted = `Permission to use Bash has been denied: the permission ask was dropped unanswered because the switchboard's parked-ask table was full. ${DENIAL_WORKAROUND_GUIDANCE}`
check('expired ask denial classifies', isDenialResultText(expired))
check('evicted ask denial classifies', isDenialResultText(evicted))

console.log('§3 — POISON: the retired switchboard mints do NOT classify')
check('"denied from the switchboard by operator" is NOT a denial', !isDenialResultText('denied from the switchboard by operator'))
check(
  'the old expiry sentence (no canon lead/tail) is NOT a denial',
  !isDenialResultText(
    'nobody answered the permission ask for Bash within 5m, so it expired. Do not retry it blindly: stop, state plainly which action needs approval and why, and end the turn — the operator can answer from the switchboard and re-run.',
  ),
)

console.log('§4 — the daemon source builds denials from the canon')
{
  const src = readFileSync(join(ROOT, 'src/daemon/permissionAsks.ts'), 'utf8')
  check(
    'the operator-No denial is REJECT_MESSAGE_WITH_REASON_PREFIX / REJECT_MESSAGE',
    src.includes('feedback ? REJECT_MESSAGE_WITH_REASON_PREFIX + feedback : REJECT_MESSAGE'),
  )
  check('POISON: the "denied from the switchboard by" mint is gone from the value', !src.includes('`denied from the switchboard by ${by}`'))
  check(
    'the expiry denial carries the classifier lead and the shared tail',
    src.includes('has been denied:') && src.includes('${DENIAL_WORKAROUND_GUIDANCE}'),
  )
  check('the canon is imported from rejectionText', src.includes("from '../utils/messages/rejectionText.js'"))
}

process.exit(failures === 0 ? 0 : 1)
