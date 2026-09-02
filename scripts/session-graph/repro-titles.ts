#!/usr/bin/env bun
// ============================================================================
//  repro-titles — reproducer (EXPECT-RED until M2/M3).
//
//  The gap this repro pins: no versioned SessionDescriptor exists and no one
//  renderer emits `Agent · Mission · Worktree`. Session titles today are the
//  terminal-title OSC seam and per-surface labels; nothing is coalesced,
//  revisioned, reconnect-durable, or provably absent from prompt bytes.
// ============================================================================
import { checker } from '../engine-durability/harness.ts'

const t = checker()

t.section('CS-13 — the session descriptor + the ONE title renderer exist')
let mod: Record<string, unknown> | null = null
try {
  mod = (await import('../../src/services/crew/descriptor.ts')) as Record<string, unknown>
} catch {
  mod = null
}
t.check(
  'src/services/crew/descriptor.ts loads',
  mod !== null,
  mod ? 'loaded' : 'module absent — no session descriptor owner',
)
t.check('the descriptor publisher exists (publishSessionDescriptor)', typeof mod?.publishSessionDescriptor === 'function')
t.check('the ONE pure renderer exists (renderSessionTitle)', typeof mod?.renderSessionTitle === 'function')
if (mod && typeof mod.renderSessionTitle === 'function') {
  const render = mod.renderSessionTitle as (d: {
    agentLabel: string
    missionLabel?: string
    worktreeLabel?: string
  }) => string
  const full = render({ agentLabel: 'Atlas', missionLabel: 'Fix auth', worktreeLabel: 'wt-auth' })
  t.check(
    'the rendered form is Agent · Mission · Worktree',
    full === 'Atlas · Fix auth · wt-auth',
    full,
  )
} else {
  t.check('the rendered form is Agent · Mission · Worktree', false, 'renderer absent')
}

t.finish('repro-titles')
