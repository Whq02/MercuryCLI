#!/usr/bin/env bun
// ============================================================================
//  scripts/notifications/prove-attention-visibility.ts — the MINTED
//  250 ms visibility budget ("the 250 ms figure exists nowhere —
//  mints it"; §13's event-to-visible-semantic-state gate,
//  measured at the attention projection).
//
//  The path under test is the REAL production chain: an authoritative event
//  (a durable obligation raised at the crew owner) → the owner's change
//  seam → the obligations bridge cache refresh → the attention store
//  recompute → the armed consumer's snapshot shows the needs-you item.
//  Budget: p95 ≤ 250 ms over 20 raises (in-process semantic visibility —
//  the PTY paint half of §13 rides the latency matrix).
//
//  Settlement visibility is measured too: resolving the obligation must
//  retract the item (bucket 'completed') within the same budget — an
//  answered question may never linger as needs-you.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { join } from 'node:path'
import { checker, scratchRoot } from '../engine-durability/harness.ts'

const t = checker()
const root = scratchRoot('attention-visibility')
process.env.MERCURY_CREW_DIR = join(root, 'crew')

const obl = await import('../../src/services/crew/obligations.js')
await import('../../src/services/crew/obligationsBridge.js')
const store = await import('../../src/services/attention/store.js')

// Arm the store the way a real consumer does.
const unsub = store.subscribeAttentionStore(() => {})

function itemPresent(subjectId: string, bucket: string): boolean {
  const item = store.cachedAttentionStore().attention.items.get(subjectId)
  return item !== undefined && item.bucket === bucket
}

async function waitVisible(subjectId: string, bucket: string, budgetMs: number): Promise<number> {
  const started = Date.now()
  for (;;) {
    if (itemPresent(subjectId, bucket)) return Date.now() - started
    if (Date.now() - started > budgetMs) return -1
    await new Promise(r => setTimeout(r, 5))
  }
}

function pct(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0
}

t.section('§1 — raise → visible needs-you within the minted 250 ms budget (p95, 20 raises)')
{
  const raiseLatencies: number[] = []
  const settleLatencies: number[] = []
  let failures = 0
  for (let i = 0; i < 20; i++) {
    // The switchboard scope — the one cwd-independent file every minting
    // side writes and the bridge reads (the production chain under test).
    const row = await obl.upsertObligation({
      ref: `vis-${i}`,
      sessionId: 'sess-vis',
      question: `visible ${i}?`,
      owner: 'op',
      scope: 'switchboard',
    })
    const subjectId = `obligation:${row.obligationId}`
    const raiseMs = await waitVisible(subjectId, 'needs-you', 2000)
    if (raiseMs < 0) failures++
    else raiseLatencies.push(raiseMs)
    await obl.resolveObligation(row.obligationId, { kind: 'resolved', scope: 'switchboard' })
    const settleMs = await waitVisible(subjectId, 'completed', 2000)
    if (settleMs < 0) failures++
    else settleLatencies.push(settleMs)
  }
  t.check('every raise and settlement became visible (no 2 s timeouts)', failures === 0, `${failures} timeout(s)`)
  const raiseP95 = pct(raiseLatencies, 95)
  const settleP95 = pct(settleLatencies, 95)
  t.check(
    `raise → needs-you visible p95 ≤ 250 ms — p95=${raiseP95}ms`,
    raiseP95 <= 250,
    JSON.stringify({ p50: pct(raiseLatencies, 50), p95: raiseP95, max: Math.max(...raiseLatencies) }),
  )
  t.check(
    `settle → retraction visible p95 ≤ 250 ms — p95=${settleP95}ms`,
    settleP95 <= 250,
    JSON.stringify({ p50: pct(settleLatencies, 50), p95: settleP95, max: Math.max(...settleLatencies) }),
  )
}

t.section('§2 — the visibility path is the REAL armed-store chain')
{
  const state = store._attentionStoreStateForTesting()
  t.check('the store is armed through the real subscriber seam', state.armed === true, JSON.stringify(state))
}

unsub()

t.finish('prove-attention-visibility')
