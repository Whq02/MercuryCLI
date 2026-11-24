#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'

const t = checker()
const {
  CONCOURSE_SESSION_STATES,
  TERMINAL_STATES,
  decideTransition,
} = await import('../../src/daemon/concourse-workers/concourseLifecycle.js')
type State = (typeof CONCOURSE_SESSION_STATES)[number]

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

t.finish('prove-concourse-lifecycle')
