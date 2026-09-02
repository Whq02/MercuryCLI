#!/usr/bin/env bun
// ============================================================================
//  scripts/notifications/prove-concourse-lifecycle.ts — (the
//  basis): the session lifecycle is typed, table-driven, and rejects
//  illegal regression.
//
//  §1  the §5.2 table verbatim: every listed exit is legal with the right
//      entry-proof class; every unlisted pair refuses.
//  §2  terminal immutability: completed/failed/cancelled refuse EVERY move.
//  §3  idempotency: duplicate delivery of the current state is a no-op,
//      never an error and never a second receipt.
//  §4  the §5.5/§6.2 projections: live-state semantics (queued is NOT
//      live) + the attention-first board order.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'

const t = checker()
const {
  BOARD_ORDER,
  CONCOURSE_SESSION_STATES,
  TERMINAL_STATES,
  boardRank,
  decideTransition,
  isLiveState,
} = await import('../../src/daemon/concourseLifecycle.js')
type State = (typeof CONCOURSE_SESSION_STATES)[number]

// The §5.2 table, restated INDEPENDENTLY (the prover's own copy — a table
// typo in the owner cannot self-certify).
const EXPECT: Record<State, State[]> = {
  draft: ['queued', 'cancelled'],
  queued: ['starting', 'paused', 'cancelled', 'failed'],
  starting: ['working', 'stalled', 'failed', 'cancelled'],
  working: ['needs-you', 'stalled', 'ready-to-review', 'completed', 'failed', 'paused', 'cancelled'],
  'needs-you': ['working', 'paused', 'cancelled', 'failed'],
  stalled: ['queued', 'starting', 'working', 'failed', 'cancelled'],
  'ready-to-review': ['working', 'completed', 'cancelled'],
  paused: ['queued', 'starting', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

t.section('§1 — the §5.2 table, exhaustively (121 ordered pairs)')
{
  let wrong = 0
  const detail: string[] = []
  for (const from of CONCOURSE_SESSION_STATES) {
    for (const to of CONCOURSE_SESSION_STATES) {
      const d = decideTransition(from, to)
      const want =
        from === to ? 'noop' : TERMINAL_STATES.has(from) ? 'terminal' : EXPECT[from].includes(to) ? 'legal' : 'illegal'
      const got =
        d.legal === true ? 'legal' : d.reason === 'idempotent-noop' ? 'noop' : d.reason === 'terminal-immutable' ? 'terminal' : 'illegal'
      if (want !== got) {
        wrong++
        if (detail.length < 5) detail.push(`${from}→${to}: want ${want} got ${got}`)
      }
    }
  }
  t.check('every ordered state pair adjudicates exactly per the table', wrong === 0, detail.join('; ') || '121/121')
}

t.section('§2 — entry proofs ride every legal transition')
{
  const missing: string[] = []
  for (const from of CONCOURSE_SESSION_STATES) {
    for (const to of EXPECT[from]) {
      const d = decideTransition(from, to)
      if (!(d.legal === true && typeof d.entryProof === 'string' && d.entryProof.length > 0)) {
        missing.push(`${from}→${to}`)
      }
    }
  }
  t.check('every legal transition names its entry-proof class', missing.length === 0, missing.join(', ') || 'all named')
  const started = decideTransition('queued', 'working')
  t.check(
    'queued can NEVER render as started (no queued→working shortcut)',
    started.legal === false && started.reason === 'illegal-transition',
    JSON.stringify(started),
  )
}

t.section('§3 — the projections')
{
  t.check('queued/starting/draft are NOT live (§5.5)', !isLiveState('queued') && !isLiveState('starting') && !isLiveState('draft'), 'ok')
  t.check(
    'working/needs-you/stalled/paused/ready-to-review ARE live',
    (['working', 'needs-you', 'stalled', 'paused', 'ready-to-review'] as State[]).every(isLiveState),
    'ok',
  )
  t.check(
    'the board order is attention-first (needs-you → stalled → ready-to-review → working)',
    boardRank('needs-you') < boardRank('stalled') &&
      boardRank('stalled') < boardRank('ready-to-review') &&
      boardRank('ready-to-review') < boardRank('working') &&
      boardRank('working') < boardRank('queued'),
    JSON.stringify(BOARD_ORDER),
  )
}

t.finish('prove-concourse-lifecycle')
