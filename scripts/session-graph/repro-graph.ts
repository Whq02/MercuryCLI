#!/usr/bin/env bun
// ============================================================================
//  repro-graph — reproducer (EXPECT-RED until M8).
//
//  The baseline this repro pins: the relations fold (spawned-by /
//  depends-on / worktree / overlap) and the board's indented GRAPH tree exist
// What does NOT exist: conversation and folio link
//  edges, mission/work-item dependency nodes joined with owner + current
//  focus, and the graph reading from the M2 crew projection so every node
//  resolves to a canonical AgentId.
// ============================================================================
import { checker } from '../engine-durability/harness.ts'

const t = checker()

t.section('CS-22 — the session graph projection exists at its pinned owner')
let mod: Record<string, unknown> | null = null
try {
  mod = (await import('../../src/services/crew/graph.ts')) as Record<string, unknown>
} catch {
  mod = null
}
t.check(
  'src/services/crew/graph.ts loads',
  mod !== null,
  mod ? 'loaded' : 'module absent — no session graph projection',
)
t.check('the graph assembly exists (assembleSessionGraph)', typeof mod?.assembleSessionGraph === 'function')
t.check(
  'edge kinds extend the relations vocabulary with conversation + folio links',
  Array.isArray(mod?.GRAPH_EDGE_KINDS) &&
    ['spawned-by', 'depends-on', 'worktree', 'overlap', 'conversation', 'folio'].every(k =>
      (mod!.GRAPH_EDGE_KINDS as string[]).includes(k),
    ),
)

t.finish('repro-graph')
