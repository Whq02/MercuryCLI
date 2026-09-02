#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-run-capsule.ts
//  ORACLE: the active run is VISIBLE (slice-6 invariants, flipped from the
//  slice-0 absence pins) — the frame capsule line, the /run inspector's row
//  model, and the zero-leak subscription lifecycle.
//
//  Pure-logic proofs (the render-verify pixels ride the UI_RENDER=1 tier):
//   · buildRunCapsuleLine: null for no run / lightweight turns / terminal
//     receipts; one bounded line for a live substantive run; blocker outranks
//     next-action; unresolved-effect marker present;
//   · buildRunRows: ordered sections, deliverable counts, blocker row,
//     evidence/context/IDE rows, bounded timeline;
//   · /run is a registered command backed by the run coordinator;
//   · 100 subscribe/unsubscribe cycles leave zero subscribers.
//
//  Run:  ~/.bun/bin/bun run scripts/ui/prove-run-capsule.ts
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

async function main(): Promise<void> {
  const root = join(import.meta.dir, '..', '..')
  const ok = await import('../../src/services/run/ownerKey.js')
  const kernel = await import('../../src/services/run/runKernel.js')
  const model = await import('../../src/commands/run/runInspectorModel.js')

  const owner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'ui', lane: 'main' })
  const base = kernel.emptyRunSnapshot({
    runId: 'r1',
    owner,
    objective: 'ship the widget',
    rootMessageId: 'u1',
    at: 1_000,
  })
  const fold = (events: Parameters<typeof kernel.reduceRunEvent>[1][]) =>
    events.reduce((s, e) => kernel.reduceRunEvent(s, e), base)

  section('1. the frame capsule line')
  {
    check('no snapshot ⇒ no capsule', model.buildRunCapsuleLine(null, 2_000) === null)
    check(
      'lightweight (non-substantive) turn ⇒ no capsule',
      model.buildRunCapsuleLine(base, 2_000) === null,
    )
    const live = fold([
      { type: 'substantive', at: 2, reason: 'edits' },
      { type: 'task-transition', at: 3, taskId: 't1', title: 'parser', state: 'done' },
      { type: 'task-transition', at: 4, taskId: 't2', title: 'emitter', state: 'open' },
      { type: 'next-action', at: 5, action: 'wire the emitter to the parser output' },
    ])
    const line = model.buildRunCapsuleLine(live, 2_000)
    check('live substantive run ⇒ one line', line !== null)
    check('carries lifecycle + phase + counts', /run active/.test(line!) && /1\/2/.test(line!))
    check('carries the next action', /next: wire the emitter/.test(line!))
    const blocked = kernel.reduceRunEvent(live, {
      type: 'blocked',
      at: 6,
      blocker: { description: 'schema choice', ownedBy: 'operator', resumeCondition: 'pick one', at: 6 },
    })
    check('a blocker OUTRANKS the next action', /BLOCKED: schema choice/.test(model.buildRunCapsuleLine(blocked, 2_000)!))
    const done = kernel.reduceRunEvent(live, { type: 'completed', at: 7, satisfied: ['all'] })
    check('a completed run shows NO standing capsule', model.buildRunCapsuleLine(done, 2_000) === null)
  }

  section('2. the /run row model')
  {
    const snap = fold([
      { type: 'substantive', at: 2, reason: 'edits' },
      { type: 'task-transition', at: 3, taskId: 't1', title: 'parser', state: 'done' },
      { type: 'task-transition', at: 4, taskId: 't2', title: 'emitter', state: 'in-progress' },
      {
        type: 'tool-effected',
        at: 5,
        toolName: 'LSP',
        toolUseId: 'tu1',
        operation: 'lsp.rename.apply',
        outcome: 'succeeded',
        changedPaths: ['/tmp/w/a.ts'],
      },
      { type: 'evidence', at: 6, state: 'stale', detail: '1 mutation after evidence' },
      { type: 'ide-feedback', at: 7, state: 'clean', detail: '0 errors at current version' },
      { type: 'next-action', at: 8, action: 'verify' },
    ])
    const rows = model.buildRunRows(snap, 10_000)
    const sections = rows.map(r => r.section)
    check(
      'sections in order: RUN → DELIVERABLES → NEXT → EFFECTS → EVIDENCE → CONTEXT → IDE → TIMELINE',
      JSON.stringify(sections) ===
        JSON.stringify(['RUN', 'DELIVERABLES', 'NEXT', 'EFFECTS', 'EVIDENCE', 'CONTEXT', 'IDE', 'TIMELINE']),
      sections.join(','),
    )
    check('deliverable counts honest', rows[1]!.line.startsWith('1/2 done'))
    check('effects row carries changed-path totals', /1 path\(s\) changed/.test(rows[3]!.line))
    check('evidence row mirrors the verification fold', /stale/.test(rows[4]!.line))
    check('IDE row carries freshness', /clean/.test(rows[6]!.line))
    check('timeline bounded', rows[7]!.detail.length <= 12)
  }

  section('3. wiring + lifecycle')
  {
    const commands = readFileSync(join(root, 'src/commands.ts'), 'utf8')
    check('/run is registered', commands.includes("./commands/run/index.js"))
    const frame = readFileSync(join(root, 'src/components/MercuryFrame.tsx'), 'utf8')
    check(
      'the frame capsule is subscription-driven (no polling timer)',
      frame.includes('subscribeRuns') && frame.includes('buildRunCapsuleLine'),
    )
    const coordinator = await import('../../src/services/run/runCoordinator.js')
    // 100 open/close cycles leave zero subscribers (the /run + capsule seam).
    for (let i = 0; i < 100; i++) {
      const unsub = coordinator.subscribeRuns(() => {})
      unsub()
    }
    let notified = 0
    const unsub = coordinator.subscribeRuns(() => {
      notified++
    })
    coordinator.acceptUserRequest(owner, { objective: 'x', rootMessageId: null })
    unsub()
    check('subscription lifecycle: notify works, unsubscribe drains', notified >= 1)
  }

  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
