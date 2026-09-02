#!/usr/bin/env bun
// ============================================================================
//  scripts/attention/prove-relations.ts — A1: the relationship
//  fold's laws.
//
//  EXPECT-RED at the pre-fix tree, promoted to a standing proof in the same
//  commit as the fold.
//
//    §1 vocabulary — the four edge kinds.
//    §2 OWNER-EVENTS-ONLY — the fold never invents an edge; every edge names
//       its owner + sourceEventId.
//    §3 IDEMPOTENT — same facts twice ≡ once; rebuilt ≡ incremental.
//    §4 OVERLAP HONESTY — overlap edges carry per-set path provenance
//       (reported | changed | unknown) and the module's own vocabulary never
//       claims a conflict.
// ============================================================================
import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

let m: typeof import('../../src/services/attention/relations.ts') | null = null
try {
  m = await import('../../src/services/attention/relations.ts')
} catch {
  m = null
}
if (!m) {
  t.check('src/services/attention/relations.ts loads', false, 'module absent')
  t.finish('prove-relations')
}
const mod = m!

t.section('§1 — vocabulary')
t.check(
  'RELATION_EDGE_KINDS is exactly the four kinds',
  JSON.stringify(mod.RELATION_EDGE_KINDS) ===
    JSON.stringify(['spawned-by', 'depends-on', 'worktree', 'overlap']),
)

const edge = (kind: string, from: string, to: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind,
  from,
  to,
  owner: 'run-manifest',
  sourceEventId: `ev-${kind}-${from}-${to}`,
  ...over,
})

t.section('§2 — owner events only')
{
  const empty = mod.foldRelations(mod.emptyRelationState(), [])
  t.check('fold([]) is empty', mod.relationEdges(empty).length === 0)
  const s = mod.foldRelations(
    mod.emptyRelationState(),
    [edge('spawned-by', 'agent:a', 'session:root')] as never,
  )
  const edges = mod.relationEdges(s)
  t.check('one fact ⇒ one edge', edges.length === 1)
  t.check(
    'the edge carries owner + sourceEventId verbatim',
    edges[0]!.owner === 'run-manifest' &&
      edges[0]!.sourceEventId === 'ev-spawned-by-agent:a-session:root',
  )
}

t.section('§3 — idempotence + equivalence')
{
  const F = [
    edge('spawned-by', 'agent:a', 'session:root'),
    edge('worktree', 'agent:a', '/tmp/wt-a'),
    edge('depends-on', 'task:2', 'task:1', { owner: 'tasks' }),
  ] as never[]
  const once = mod.foldRelations(mod.emptyRelationState(), F as never)
  const twice = mod.foldRelations(once, F as never)
  t.check(
    'same facts twice ≡ once',
    JSON.stringify(mod.relationEdges(once)) === JSON.stringify(mod.relationEdges(twice)),
  )
  const incremental = (F as never[]).reduce(
    (s, f) => mod.foldRelations(s, [f] as never),
    mod.emptyRelationState(),
  )
  t.check(
    'rebuilt ≡ incremental',
    JSON.stringify(mod.relationEdges(once)) === JSON.stringify(mod.relationEdges(incremental)),
  )
}

t.section('§4 — overlap honesty')
{
  const s = mod.foldRelations(
    mod.emptyRelationState(),
    [
      edge('overlap', 'agent:a', 'agent:b', {
        owner: 'agent-results',
        paths: [
          { path: 'src/x.ts', from: 'changed', to: 'reported' },
          { path: 'src/y.ts', from: 'changed', to: 'unknown' },
        ],
      }),
    ] as never,
  )
  const e = mod.relationEdges(s)[0]! as {
    paths?: Array<{ path: string; from: string; to: string }>
  }
  t.check(
    'overlap edges carry per-set path provenance (reported | changed | unknown)',
    Array.isArray(e.paths) &&
      e.paths.length === 2 &&
      e.paths.every(p => ['reported', 'changed', 'unknown'].includes(p.from) && ['reported', 'changed', 'unknown'].includes(p.to)),
  )
  const src = readFileSync('src/services/attention/relations.ts', 'utf8')
  t.check(
    "the module's vocabulary never claims a conflict (a hint, never a verdict)",
    !/conflict/i.test(src),
  )
}

t.finish('prove-relations')
