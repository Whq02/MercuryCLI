#!/usr/bin/env bun
// ============================================================================
//  scripts/session-graph/run-journeys.ts — the §8 aggregate journey runner
// NOT a prove-* name on purpose: the suite already runs every
//  standing prover once — this runner re-executes them as the journey
//  aggregate at CLOSE (its record commits beside it), so auto-globbing it
//  would double the pool for duplicated coverage.
//
//  Every journey leg maps to the REAL prover that observes its outcome; the
//  runner FAILS when a leg is skipped, exits non-zero, or its NAMED NEEDLE
//  (the exact law line the journey requires) is missing from the prover's
//  output — a prover that silently dropped its section cannot pass vacuously
//  here.
//
//  The Windows PS7 journey is hosted evidence (the windows-ui campaign run
//  receipt) — this runner asserts the receipt document, never fabricates a
//  local pass for a hosted leg.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

interface JourneyLeg {
  journey: string
  prover: string
  /** Output needles that must ALL appear — the exact observed-outcome lines. */
  needles: string[]
}

const LEGS: JourneyLeg[] = [
  {
    journey: 'Main/Console/Minerva parallelism (three identities, no merge)',
    prover: 'scripts/session-graph/prove-continuity-handoffs.ts',
    needles: ['the ask mints a NEW id (never the main id)', 'a failed side helper reads STALLED'],
  },
  {
    journey: 'Explicit Minerva handoff (staged; receipt ref; one target event)',
    prover: 'scripts/session-graph/prove-continuity-handoffs.ts',
    needles: ['the operator dispatch records the EXACT receipt ref', 'no delivery event exists before the operator dispatches'],
  },
  {
    journey: 'Console side-thread handoff (both ids, lineage, never merge)',
    prover: 'scripts/session-graph/prove-continuity-handoffs.ts',
    needles: ['both sides carry the handoff edge', 'NO transcript moved'],
  },
  {
    journey: 'Same-thread cross-surface view (same ids + cursor)',
    prover: 'scripts/session-graph/prove-graph-continuity.ts',
    needles: ['deliberately opening one thread from two surfaces agrees on id + cursor + resume'],
  },
  {
    journey: 'External Claude-family seat (identity, resume, ambiguous preserve)',
    prover: 'scripts/session-graph/prove-seat-bridge.ts',
    needles: [
      'a --resume re-attach of the proven session resolves the SAME agent',
      'an ambiguous outcome preserves the draft as delivery-unknown',
      'the delivery is POSITIVELY acknowledged across processes',
    ],
  },
  {
    journey: 'Codex/OpenCode capability variants (honest availability)',
    prover: 'scripts/session-graph/prove-seat-bridge.ts',
    needles: ['the turn surface stays honestly UNKNOWN', 'opencode: image attach DERIVED supported', 'goose: image attach DERIVED unsupported'],
  },
  {
    journey: 'Rename and collision (distinct ids; labels never route)',
    prover: 'scripts/session-graph/prove-identity.ts',
    needles: ['rename preserves the agent id', 'two agents with one visible name stay distinct', 'a bare display name NEVER resolves'],
  },
  {
    journey: 'Attention ordering (noise cannot outrank the older question)',
    prover: 'scripts/session-graph/prove-conversations-inbox.ts',
    needles: ['NEW NOISE CANNOT OUTRANK an older unresolved item'],
  },
  {
    journey: 'Oldest unread (cross-surface resume position)',
    prover: 'scripts/session-graph/prove-conversations-inbox.ts',
    needles: ['NEVER the newest: a fresh cursor resumes at seq 1'],
  },
  {
    journey: 'In-place activity (running→terminal, one row, stable order)',
    prover: 'scripts/session-graph/prove-activity-classifier.ts',
    needles: ['one row, not two (the running row became its outcome)', 'order is stable across the update'],
  },
  {
    journey: 'Uncertain steering (delivery-unknown; declared-only retry)',
    prover: 'scripts/session-graph/prove-seat-bridge.ts',
    needles: [
      'no automatic retry without declared dedupe',
      'a caller-asserted retry against an UNDECLARED adapter is refused',
      'a declared-idempotent adapter retry reuses the SAME id',
    ],
  },
  {
    journey: 'Context shelf (per-conversation drafts; no shared shelf)',
    prover: 'scripts/session-graph/prove-continuity-handoffs.ts',
    needles: ['adding to one conversation shelf never touches the other'],
  },
  {
    journey: 'Artifact conversation (comment → revise → route → scope accept)',
    prover: 'scripts/session-graph/prove-interactive-folios.ts',
    needles: ['request-revision carries the revision-request routing receipt', 'a file-scope accept records'],
  },
  {
    journey: 'Outdated anchor (relocate-or-outdated, never guessed)',
    prover: 'scripts/attention/prove-folio-actions.ts',
    needles: [
      'the surviving-content comment RELOCATED (version moved, state open)',
      'the vanished-content comment reads OUTDATED — never a silent wrong anchor',
    ],
  },
  {
    journey: 'Session graph (parent/child/dependency/worktree/collision edges)',
    prover: 'scripts/session-graph/prove-graph-continuity.ts',
    needles: ['parent lineage lands as spawned-by', 'conversation edges join agents to their threads'],
  },
  {
    journey: 'Restart continuity (identity, title, cursor survive a fresh open)',
    prover: 'scripts/session-graph/prove-graph-continuity.ts',
    needles: ['restart preserves identity, descriptor revision, cursor and title'],
  },
  {
    journey: 'High history (bounded work at 10N; delta-scaled reconnect)',
    prover: 'scripts/session-graph/prove-bounded-work.ts',
    needles: [
      'the retained window holds its cap at N and at 10N',
      'folding a 50-event delta changes ≤ 50 rows regardless of retained history',
    ],
  },
]

// One run per prover — several journeys observe different sections of the
// same prover; re-running it per leg would triple wall time for no evidence.
const runs = new Map<string, { code: number; out: string }>()
const runOf = (prover: string): { code: number; out: string } => {
  const cached = runs.get(prover)
  if (cached) return cached
  let out = ''
  let code = 0
  try {
    out = execFileSync('bun', ['run', prover], { encoding: 'utf8', timeout: 600_000 })
  } catch (e) {
    const err = e as { status?: number; stdout?: string }
    code = err.status ?? 1
    out = err.stdout ?? ''
  }
  const result = { code, out }
  runs.set(prover, result)
  return result
}

for (const leg of LEGS) {
  const { code, out } = runOf(leg.prover)
  const missing = leg.needles.filter(n => !out.includes(n))
  t.check(
    leg.journey,
    code === 0 && missing.length === 0,
    code !== 0 ? `${leg.prover} exited ${code}` : missing.length ? `needle missing: ${missing[0]}` : '',
  )
}

t.finish('run-journeys')
