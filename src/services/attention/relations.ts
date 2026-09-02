/**
 * relations — the typed vocabulary and the PURE fold of the
 * session relationship model (who-spawned-whom · dependencies · worktrees ·
 * observed touched-path overlap).
 *
 * OWNER-EVENTS-ONLY LAW: every edge folds from ONE named owner event and
 * carries its `sourceEventId` receipt — runKernel/runManifest spawns, task
 * blockedBy facts, workbench lane worktrees, agentResults observed
 * changedPaths, side-question parentage. The fold never invents an edge.
 *
 * OVERLAP HONESTY: an overlap edge lists the exact intersecting
 * paths, each side tagged with its provenance — 'reported' (the agent said
 * it), 'changed' (observed mutation receipts), or 'unknown'. It is a HINT
 * for the operator's eye; this module deliberately has no stronger claim in
 * its vocabulary.
 *
 * FOLD LAWS (proved by scripts/attention/prove-relations.ts): idempotent
 * replay · rebuilt ≡ live-incremental · edges keyed (kind|from|to), a later
 * fact for the same key replacing the edge. Pure and I/O-free; gatherers
 * live with the attention store.
 */

export const RELATION_EDGE_KINDS = [
  'spawned-by',
  'depends-on',
  'worktree',
  'overlap',
] as const
export type RelationEdgeKind = (typeof RELATION_EDGE_KINDS)[number]

/** Path provenance on an overlap side. */
export type OverlapProvenance = 'reported' | 'changed' | 'unknown'

export interface OverlapPath {
  path: string
  /** Provenance of the path in the `from` subject's set. */
  from: OverlapProvenance
  /** Provenance of the path in the `to` subject's set. */
  to: OverlapProvenance
}

/** One owner fact — the fold's only input (also the edge shape it projects). */
export interface RelationFact {
  kind: RelationEdgeKind
  /** Subject ids in the attention vocabulary (`<family>:<subject>`), or a
   *  filesystem path for `worktree` targets. */
  from: string
  to: string
  owner: string
  sourceEventId: string
  /** Overlap edges only: the exact intersecting paths with provenance. */
  paths?: readonly OverlapPath[]
}

export interface RelationEdge {
  kind: RelationEdgeKind
  from: string
  to: string
  owner: string
  sourceEventId: string
  paths?: readonly OverlapPath[]
}

export interface RelationState {
  /** `${kind}|${from}|${to}` → edge. */
  edges: ReadonlyMap<string, RelationEdge>
}

export function emptyRelationState(): RelationState {
  return { edges: new Map() }
}

const keyOf = (f: { kind: string; from: string; to: string }): string =>
  `${f.kind}|${f.from}|${f.to}`

/**
 * The PURE fold: apply owner facts. An identical fact (same key + same
 * sourceEventId) is a no-op; a later fact for the same key replaces the edge
 * (e.g. a fresh overlap observation supersedes the previous path set).
 */
export function foldRelations(
  state: RelationState,
  facts: readonly RelationFact[],
): RelationState {
  if (facts.length === 0) return state
  let edges: Map<string, RelationEdge> | null = null
  for (const f of facts) {
    const key = keyOf(f)
    const prev = (edges ?? state.edges).get(key)
    if (prev && prev.sourceEventId === f.sourceEventId) continue
    if (!edges) edges = new Map(state.edges)
    edges.set(key, {
      kind: f.kind,
      from: f.from,
      to: f.to,
      owner: f.owner,
      sourceEventId: f.sourceEventId,
      ...(f.paths !== undefined ? { paths: f.paths } : {}),
    })
  }
  return edges ? { edges } : state
}

/** The edges, unordered (surfaces own their traversal order). */
export function relationEdges(state: RelationState): RelationEdge[] {
  return [...state.edges.values()]
}
