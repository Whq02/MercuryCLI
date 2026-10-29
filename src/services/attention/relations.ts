
export const RELATION_EDGE_KINDS = [
  'spawned-by',
  'depends-on',
  'worktree',
  'overlap',
] as const
export type RelationEdgeKind = (typeof RELATION_EDGE_KINDS)[number]

export type OverlapProvenance = 'reported' | 'changed' | 'unknown'

export interface OverlapPath {
  path: string
  from: OverlapProvenance
  to: OverlapProvenance
}

export interface RelationFact {
  kind: RelationEdgeKind
  from: string
  to: string
  owner: string
  sourceEventId: string
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
  edges: ReadonlyMap<string, RelationEdge>
}

export function emptyRelationState(): RelationState {
  return { edges: new Map() }
}

const keyOf = (f: { kind: string; from: string; to: string }): string =>
  `${f.kind}|${f.from}|${f.to}`

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

export function relationEdges(state: RelationState): RelationEdge[] {
  return [...state.edges.values()]
}
