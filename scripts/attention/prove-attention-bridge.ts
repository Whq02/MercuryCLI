#!/usr/bin/env bun
// ============================================================================
//  scripts/attention/prove-attention-bridge.ts — A2: the
//  workbench-family gatherer's honesty (gatherer half +/12's
//  edge sourcing).
//
//  EXPECT-RED at the pre-fix tree (the bridge is the fix), promoted in the
//  same commit. Pure: feeds a synthetic WorkbenchSnapshot slice to the
//  exported translation — no engine, no I/O.
//
//    §1 blocker → needs-you at urgency 0; the blocker text IS the reason.
//    §2 owner state vocabulary maps conservatively; UNKNOWN state = NO fact
//       (a guess is worse than silence).
//    §3 reviewQueue → ready-to-review carrying the human note.
//    §4 edges: parentId → spawned-by · worktreePath → worktree · pairwise
//       OBSERVED changedPaths → overlap with per-side provenance, truncated
//       sides reading 'unknown'.
// ============================================================================
import { checker } from '../engine-durability/harness.ts'

const t = checker()

let m: typeof import('../../src/services/workbench/attentionBridge.ts') | null = null
try {
  m = await import('../../src/services/workbench/attentionBridge.ts')
} catch {
  m = null
}
if (!m || typeof m.workbenchFactsOf !== 'function') {
  t.check('attentionBridge exports workbenchFactsOf', false, 'module or export absent')
  t.finish('prove-attention-bridge')
}
const F = m!.workbenchFactsOf

const thread = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: 'x',
  kind: 'agent',
  title: 't',
  phase: 'p',
  state: 'mystery-vocab',
  updatedAt: 2_000,
  changedPaths: [],
  refs: [],
  ...over,
})

t.section('§1 — blocker → needs-you')
{
  const { attention } = F({
    refreshedAt: 1,
    reviewQueue: [],
    threads: [thread({ id: 'a', blocker: 'approve the plan?' })] as never,
  } as never)
  const it = attention[0]
  t.check('one blocker ⇒ one needs-you item at urgency 0', attention.length === 1 && it!.bucket === 'needs-you' && it!.urgency === 0)
  t.check('the blocker text IS the reason', it!.reasonLabel === 'approve the plan?')
}

t.section('§2 — conservative state mapping')
{
  const { attention } = F({
    refreshedAt: 1,
    reviewQueue: [],
    threads: [
      thread({ id: 'run', state: 'running' }),
      thread({ id: 'pause', state: 'paused' }),
      thread({ id: 'huh', state: 'mystery-vocab' }),
    ] as never,
  } as never)
  const by = new Map(attention.map(a => [a.subjectId, a]))
  t.check("'running' → working/run-live", by.get('thread:run')?.bucket === 'working')
  t.check("'paused' → stalled/run-paused", by.get('thread:pause')?.bucket === 'stalled' && by.get('thread:pause')?.reasonCode === 'run-paused')
  t.check('UNKNOWN vocabulary emits NO fact (silence, never a guess)', !by.has('thread:huh'))
}

t.section('§3 — reviewQueue → ready-to-review')
{
  const { attention } = F({
    refreshedAt: 42,
    reviewQueue: [{ ref: 'mercury://artifact/ra-1/comments', note: 'plan: 1 open comment' }],
    threads: [],
  } as never)
  const it = attention[0]
  t.check(
    'the item carries the bucket, the code and the HUMAN note',
    attention.length === 1 &&
      it!.bucket === 'ready-to-review' &&
      it!.reasonCode === 'review-queued' &&
      it!.title === 'plan: 1 open comment',
  )
}

t.section('§4 — edges from owner rows')
{
  const { relations } = F({
    refreshedAt: 1,
    reviewQueue: [],
    threads: [
      thread({ id: 'a', parentId: 'root', worktreePath: '/wt/a', changedPaths: ['src/x.ts', 'src/y.ts'] }),
      thread({ id: 'b', changedPaths: ['src/x.ts'], totalChangedPaths: 5 }),
    ] as never,
  } as never)
  const kinds = relations.map(e => e.kind).sort()
  t.check('spawned-by + worktree + overlap present', JSON.stringify(kinds) === JSON.stringify(['overlap', 'spawned-by', 'worktree']), kinds.join(','))
  const overlap = relations.find(e => e.kind === 'overlap')!
  t.check(
    "the truncated side reads 'unknown', the full side 'changed'",
    overlap.paths?.length === 1 &&
      overlap.paths[0]!.path === 'src/x.ts' &&
      overlap.paths[0]!.from === 'changed' &&
      overlap.paths[0]!.to === 'unknown',
  )
}

t.section('§5 — the lifecycle: retraction is an explicit terminal (review B3)')
{
  const L = m! as unknown as {
    gatherWithLifecycle: (s: unknown, now: number) => { attention: Array<Record<string, unknown>> }
    _resetBridgeLifecycleForTesting: () => void
  }
  t.check('the stateful gather is exported (production and proof run the SAME path)', typeof L.gatherWithLifecycle === 'function')
  L._resetBridgeLifecycleForTesting()
  const snapA = {
    refreshedAt: 100,
    reviewQueue: [{ ref: 'mercury://artifact/ra-9', note: 'plan v1 awaits review' }],
    threads: [],
  }
  const out1 = L.gatherWithLifecycle(snapA as never, 100)
  t.check('(rig) the review item is reported', out1.attention.length === 1)
  const out2 = L.gatherWithLifecycle({ refreshedAt: 200, reviewQueue: [], threads: [] } as never, 200)
  const term = out2.attention.find(f => String(f.subjectId).startsWith('review:'))
  t.check(
    'a subject the owner stops reporting gets an explicit terminal fact (never a silent forever-item)',
    term !== undefined && term.bucket === 'completed' && term.reasonCode === 'settled',
    term ? `${term.bucket}/${term.reasonCode}` : 'no terminal emitted',
  )
  const out3 = L.gatherWithLifecycle({ refreshedAt: 300, reviewQueue: [], threads: [] } as never, 300)
  t.check('the terminal emits ONCE (the ledger forgets the retracted subject)', out3.attention.length === 0)
  L._resetBridgeLifecycleForTesting()
}

t.finish('prove-attention-bridge')
