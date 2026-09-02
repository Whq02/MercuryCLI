// ============================================================================
//  crew/graph — the live session graph.
//
//  ONE bounded assembly over the canonical owners — the M2 crew projection
//  (agents · presence · focus · worktrees), the identity registry's sessions
//  (parent lineage), the conversation registry (participants + lineage) and
//  the review heads (producer links) — so every node resolves to a canonical
//  CrewAgentId and every edge names its owner. A projection only: no second
//  store, no timers; callers assemble on demand (the board's GRAPH section,
//  the `_mercury/crew` wire) and the detail pane renders the selected node.
//
//  The edge vocabulary EXTENDS the relations fold (spawned-by · depends-on ·
//  worktree · overlap) with the crew families (conversation · folio ·
//  session) — same words where the meaning is the same, never a parallel
//  synonym.
// ============================================================================

import { getCwd } from '../../utils/cwd.js'
import { listReviewArtifactHeadsSource } from '../../utils/artifacts/reviewStore.js'
import { valueOr } from '../../substrate/sourceState.js'
import { listAgentSessions } from './identity.js'
import { listConversations } from './conversations.js'
import { resolveCrewSnapshot } from './projection.js'

export const GRAPH_EDGE_KINDS = [
  'spawned-by',
  'depends-on',
  'worktree',
  'overlap',
  'conversation',
  'folio',
  'session',
] as const
export type GraphEdgeKind = (typeof GRAPH_EDGE_KINDS)[number]

export const GRAPH_NODE_KINDS = ['agent', 'session', 'conversation', 'artifact', 'worktree'] as const
export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number]

export interface SessionGraphNode {
  /** Stable node id: `agent:<cw-…>` · `session:<id>` · `conversation:<cv-…>`
   *  · `artifact:<ra-…>` · `worktree:<path>`. */
  id: string
  kind: GraphNodeKind
  label: string
  /** The canonical owner behind the node, where one exists. */
  agentId?: string
  /** Owner-observed current focus (agents only — verbatim from the projection). */
  focus?: string
}

export interface SessionGraphEdge {
  kind: GraphEdgeKind
  from: string
  to: string
  /** The owner whose records back this edge. */
  owner: string
}

export interface SessionGraph {
  nodes: SessionGraphNode[]
  edges: SessionGraphEdge[]
  assembledAt: number
}

const MAX_NODES = 200
const MAX_EDGES = 400

/**
 * Assemble the graph one-shot (never arms any engine — the resolve path).
 * Bounded: oldest conversation/artifact nodes shed first past the caps; the
 * bound is a display window, the owning stores stay the truth.
 */
export async function assembleSessionGraph(): Promise<SessionGraph> {
  const nodes = new Map<string, SessionGraphNode>()
  const edges: SessionGraphEdge[] = []
  const addNode = (n: SessionGraphNode): void => {
    if (!nodes.has(n.id)) nodes.set(n.id, n)
  }
  const addEdge = (e: SessionGraphEdge): void => {
    if (edges.length >= MAX_EDGES) return
    if (edges.some(x => x.kind === e.kind && x.from === e.from && x.to === e.to)) return
    edges.push(e)
  }

  const snap = await resolveCrewSnapshot()
  if (snap) {
    for (const m of snap.members) {
      addNode({
        id: `agent:${m.agentId}`,
        kind: 'agent',
        label: m.label,
        agentId: m.agentId as string,
        ...(m.focus?.label !== undefined ? { focus: m.focus.label } : {}),
      })
      if (m.worktreeRef) {
        addNode({ id: `worktree:${m.worktreeRef}`, kind: 'worktree', label: m.worktreeRef })
        addEdge({
          kind: 'worktree',
          from: `agent:${m.agentId}`,
          to: `worktree:${m.worktreeRef}`,
          owner: m.presence.source,
        })
      }
    }
    // Observed collisions: two agents on ONE worktree is an overlap fact.
    const byWorktree = new Map<string, string[]>()
    for (const m of snap.members) {
      if (!m.worktreeRef) continue
      byWorktree.set(m.worktreeRef, [...(byWorktree.get(m.worktreeRef) ?? []), m.agentId as string])
    }
    for (const [wt, agents] of byWorktree) {
      if (agents.length < 2) continue
      for (let i = 1; i < agents.length; i++) {
        addEdge({
          kind: 'overlap',
          from: `agent:${agents[0]}`,
          to: `agent:${agents[i]}`,
          owner: `worktree:${wt}`,
        })
      }
    }
  }

  const sessions = await listAgentSessions().catch(() => [])
  for (const s of sessions) {
    if (s.endedAt !== undefined) continue
    addNode({ id: `session:${s.sessionId}`, kind: 'session', label: s.sessionId, agentId: s.agentId as string })
    addEdge({ kind: 'session', from: `session:${s.sessionId}`, to: `agent:${s.agentId}`, owner: 'crew-identity' })
    if (s.parentSessionId !== undefined) {
      addEdge({
        kind: 'spawned-by',
        from: `session:${s.sessionId}`,
        to: `session:${s.parentSessionId}`,
        owner: 'crew-identity',
      })
    }
    if (s.missionRef !== undefined) {
      addEdge({ kind: 'depends-on', from: `session:${s.sessionId}`, to: s.missionRef, owner: 'crew-identity' })
    }
  }

  const conversations = await listConversations().catch(() => [])
  // The window is the LIVE view: newest-updated first, and the MAIN thread —
  // the default parent of every side/refinement lineage — always included
  // (raw insertion order would silently shed it once a project outgrows the
  // window, dangling every lineage edge).
  const windowed = [...conversations]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 60)
  const mainConv = conversations.find(c => (c.conversationId as string) === 'cv-main')
  if (mainConv && !windowed.includes(mainConv)) windowed.push(mainConv)
  // Real nodes first (titled); lineage stubs only fill gaps afterwards —
  // addNode is first-wins, so a stub can never mask a titled node.
  for (const c of windowed) {
    addNode({ id: `conversation:${c.conversationId}`, kind: 'conversation', label: c.title })
  }
  for (const c of windowed) {
    for (const p of c.participants) {
      if (p.kind !== 'agent') continue
      addEdge({
        kind: 'conversation',
        from: `agent:${p.agentId}`,
        to: `conversation:${c.conversationId}`,
        owner: 'crew-conversations',
      })
    }
    // A lineage edge lands when EITHER side is in the window (normalized to
    // the 'from' direction so the pair dedupes); the out-of-window endpoint
    // becomes a stub node rather than a dangling id.
    for (const l of c.lineage) {
      const from = l.direction === 'from' ? c.conversationId : l.otherConversationId
      const to = l.direction === 'from' ? l.otherConversationId : c.conversationId
      addNode({ id: `conversation:${from}`, kind: 'conversation', label: String(from) })
      addNode({ id: `conversation:${to}`, kind: 'conversation', label: String(to) })
      addEdge({
        kind: 'conversation',
        from: `conversation:${from}`,
        to: `conversation:${to}`,
        owner: `lineage:${l.kind}`,
      })
    }
    for (const w of c.workItemRefs) {
      addEdge({ kind: 'depends-on', from: `conversation:${c.conversationId}`, to: w, owner: 'crew-conversations' })
    }
  }

  try {
    const heads = valueOr(listReviewArtifactHeadsSource({ root: getCwd() }), [])
    for (const h of heads.slice(0, 40)) {
      addNode({ id: `artifact:${h.id}`, kind: 'artifact', label: h.title })
      addEdge({
        kind: 'folio',
        from: `session:${h.producerSessionId}`,
        to: `artifact:${h.id}`,
        owner: 'review-journal',
      })
    }
  } catch {
    // the review store is optional input — absent reads as no folio edges
  }

  // The cap sheds by PRIORITY: structural nodes (agents · sessions ·
  // worktrees) always keep their place; MAIN is pinned FIRST among the
  // shedable (the default lineage parent may never shed while any other
  // conversation survives — the windowing above appends it LAST when it
  // fell outside the newest-60, which raw order would shed first: the final
  // audit's dangling-MAIN resurfacing); then conversations newest-first
  // (the stalest tail sheds first), and artifacts shed before any
  // conversation.
  const structural = [...nodes.values()].filter(n => n.kind === 'agent' || n.kind === 'session' || n.kind === 'worktree')
  const shedableAll = [...nodes.values()].filter(n => n.kind === 'conversation' || n.kind === 'artifact')
  const shedable = [
    ...shedableAll.filter(n => n.id === 'conversation:cv-main'),
    ...shedableAll.filter(n => n.id !== 'conversation:cv-main' && n.kind === 'conversation'),
    ...shedableAll.filter(n => n.kind === 'artifact'),
  ]
  const nodeList = [...structural, ...shedable].slice(0, MAX_NODES)
  const kept = new Set(nodeList.map(n => n.id))
  return {
    nodes: nodeList,
    edges: edges.filter(e => {
      // an edge may point at a REF (mission/work-item string) that is not a
      // node — keep those; drop edges whose node endpoints were shed.
      const fromIsNode = e.from.includes(':') && nodes.has(e.from)
      const toIsNode = e.to.includes(':') && nodes.has(e.to)
      return (!fromIsNode || kept.has(e.from)) && (!toIsNode || kept.has(e.to))
    }),
    assembledAt: Date.now(),
  }
}
