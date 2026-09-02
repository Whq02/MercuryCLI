#!/usr/bin/env bun
// ============================================================================
//  scripts/attention/repro-journey-a.ts — Journey A reproducer.
//  Pins rows (EXPECT-RED until Wave A lands).
//
//  The gap this repro pins: no five-bucket attention projection exists anywhere.
//  The nearest prior art is utils/cockpit/attentionDerive.ts — a zero-caller
//  severed-loop COUNT fold whose input queue vocabulary exists nowhere in the
//  fork — and the content-derived agentStateClassifier, which the honest-
//  attention law forbids from gating bucket entry. lands the owner at
//  the path pinned HERE (the collaboration-store idiom); this
//  reproducer flips green only when that module really exports the vocabulary.
// ============================================================================
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const OWNER = '../../src/services/attention/contracts.ts'
const BUCKETS = ['needs-you', 'ready-to-review', 'stalled', 'working', 'completed']

t.section('Journey A — the attention projection exists at its pinned owner')
let mod: Record<string, unknown> | null = null
try {
  mod = (await import(OWNER)) as Record<string, unknown>
} catch {
  mod = null
}
t.check(
  'src/services/attention/contracts.ts loads',
  mod !== null,
  mod ? 'loaded' : 'module absent — no attention projection at the pinned owner',
)
const buckets = mod?.ATTENTION_BUCKETS as unknown
t.check(
  'ATTENTION_BUCKETS is exactly the five owner-truth buckets, in order',
  Array.isArray(buckets) && JSON.stringify(buckets) === JSON.stringify(BUCKETS),
  Array.isArray(buckets) ? (buckets as string[]).join(',') : 'absent',
)
t.check(
  'the fold entry exists (foldAttention — pure, collaboration-store idiom)',
  typeof mod?.foldAttention === 'function',
)
t.check(
  'the stable sort exists (sortAttention — urgency → waiting-time → stable id)',
  typeof mod?.sortAttention === 'function',
)

t.section('Journey A — the view-model + the Workbench surface exist (RV-03/RV-05)')
let vm: Record<string, unknown> | null = null
try {
  vm = (await import('../../src/services/attention/viewModel.ts')) as Record<string, unknown>
} catch {
  vm = null
}
t.check(
  'src/services/attention/viewModel.ts loads (the federationView idiom)',
  vm !== null,
  vm ? 'loaded' : 'module absent — no attention view-model',
)
t.check('cachedAttentionView exists', typeof vm?.cachedAttentionView === 'function')
t.check('subscribeAttentionView exists', typeof vm?.subscribeAttentionView === 'function')
{
  const { readFileSync } = await import('node:fs')
  const wb = readFileSync('src/services/workbench/contracts.ts', 'utf8')
  t.check(
    'the Workbench projection vocabulary carries the attention section (ONE inbox)',
    /^\s*attention[?]?:/m.test(wb),
    'workbench contracts carry no attention member',
  )
}

t.finish('repro-journey-a')
