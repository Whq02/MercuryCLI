#!/usr/bin/env bun
// ============================================================================
//  scripts/session-graph/prove-graph-continuity.ts — the M8 session-graph +
//  cross-surface continuity laws.
//
//  Hermetic: config home + review root are mkdtemp scratch dirs (the
//  review→crew mirror rides the DEFAULT stores, so the whole home is
//  scratch-pinned per invocation — proof-hygiene).
//
//    §1 descriptors        — coalesced (unchanged republication keeps the
//                            revision), revisioned on change, durable; the
//                            ONE pure title renderer
//    §2 the session graph  — canonical-id nodes; the edge vocabulary extends
//                            the relations fold with conversation/folio/
//                            session; parent lineage and worktree edges land
//    §3 continuity laws    — the repro-continuity probe holds (same AgentId
//                            on every surface read path · deliberate same
//                            thread ⇒ same cursor + resume · restart
//                            preserves identity/revision/cursor/title)
//    §4 the review mirror  — ready-for-review appends ONE unresolved
//                            review-request on the main conversation (the
//                            ready-to-review bucket input); a decision
//                            resolves it; the artifact-class activity row
//                            lands truthfully
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'crew-graphcont-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_REVIEW_ARTIFACTS_DIR = join(scratch, 'artifacts')
mkdirSync(join(scratch, 'home'), { recursive: true })

const descriptor = await import('../../src/services/crew/descriptor.ts')
const graph = await import('../../src/services/crew/graph.ts')
const projection = await import('../../src/services/crew/projection.ts')
const identity = await import('../../src/services/crew/identity.ts')
const conversations = await import('../../src/services/crew/conversations.ts')
const activity = await import('../../src/services/crew/activity.ts')
const reviewStore = await import('../../src/utils/artifacts/reviewStore.ts')

const dir = join(scratch, 'crew-store')

t.section('§1 — descriptors: coalesced, revisioned, one pure renderer')
{
  const agent = await identity.ensureAgentIdentity({
    displayName: 'Atlas',
    binding: { bindingKind: 'adapter', bindingId: 'desc-probe-1', adapterKind: 'claude-code' },
    dir,
  })
  const d1 = await descriptor.publishSessionDescriptor(
    { agentId: agent.agentId, sessionId: 's-1', missionRef: 'fix auth', worktreeRef: 'wt-a' },
    { dir },
  )
  t.check('the first publication is revision 1', d1.revision === 1)
  const d2 = await descriptor.publishSessionDescriptor(
    { agentId: agent.agentId, sessionId: 's-1', missionRef: 'fix auth', worktreeRef: 'wt-a' },
    { dir },
  )
  t.check('an UNCHANGED republication coalesces (revision stays)', d2.revision === 1)
  const d3 = await descriptor.publishSessionDescriptor(
    { agentId: agent.agentId, sessionId: 's-1', missionRef: 'ship auth', worktreeRef: 'wt-a' },
    { dir },
  )
  t.check('a changed mission bumps the revision', d3.revision === 2)
  const readBack = await descriptor.readSessionDescriptor('s-1', { dir })
  t.check('the descriptor survives a fresh read (durable)', readBack !== null && readBack.revision === 2)
  t.check(
    'the ONE renderer emits Agent · Mission · Worktree',
    descriptor.renderSessionTitle({ agentLabel: 'Atlas', missionLabel: 'Fix auth', worktreeLabel: 'wt-auth' }) ===
      'Atlas · Fix auth · wt-auth',
  )
  t.check(
    'absent parts elide (never placeholder dashes)',
    descriptor.renderSessionTitle({ agentLabel: 'Atlas' }) === 'Atlas' &&
      descriptor.renderSessionTitle({ agentLabel: 'Atlas', worktreeLabel: 'wt' }) === 'Atlas · wt',
  )
}

t.section('§2 — the session graph: canonical ids, extended edge vocabulary')
{
  t.check(
    'GRAPH_EDGE_KINDS extends the relations vocabulary with conversation/folio/session',
    ['spawned-by', 'depends-on', 'worktree', 'overlap', 'conversation', 'folio', 'session'].every(k =>
      (graph.GRAPH_EDGE_KINDS as readonly string[]).includes(k),
    ),
  )
  // Seed the DEFAULT stores (the graph assembles over them): an agent with a
  // session + parent lineage, and a conversation with an agent participant.
  const main = await identity.ensureAgentIdentity({
    displayName: 'Mercury',
    binding: { bindingKind: 'principal', bindingId: 'agent-mercury' },
  })
  await identity.registerAgentSession({ sessionId: 'g-parent', agentId: main.agentId })
  await identity.registerAgentSession({
    sessionId: 'g-child',
    agentId: main.agentId,
    parentSessionId: 'g-parent',
  })
  await conversations.mintConversation({
    kind: 'main',
    title: 'Main session',
    participants: [{ kind: 'agent', agentId: main.agentId }],
    adoptId: conversations.MAIN_CONVERSATION_ID,
  })
  const g = await graph.assembleSessionGraph()
  t.check(
    'agent nodes resolve to canonical CrewAgentIds',
    g.nodes.some(n => n.kind === 'agent' && n.id === `agent:${main.agentId}`),
  )
  t.check(
    'session nodes + session edges land',
    g.nodes.some(n => n.kind === 'session' && n.id === 'session:g-child') &&
      g.edges.some(e => e.kind === 'session' && e.from === 'session:g-child'),
  )
  t.check(
    'parent lineage lands as spawned-by',
    g.edges.some(e => e.kind === 'spawned-by' && e.from === 'session:g-child' && e.to === 'session:g-parent'),
  )
  t.check(
    'conversation edges join agents to their threads',
    g.edges.some(
      e =>
        e.kind === 'conversation' &&
        e.from === `agent:${main.agentId}` &&
        e.to === `conversation:${conversations.MAIN_CONVERSATION_ID}`,
    ),
  )
}

t.section('§3 — the continuity laws (the repro-continuity probe)')
{
  const laws = await projection.__continuityLawsForProof()
  t.check('every surface read path resolves the same canonical AgentId', laws.sameAgentIdEverySurface)
  t.check(
    'deliberately opening one thread from two surfaces agrees on id + cursor + resume',
    laws.deliberateSameThreadSameCursor,
  )
  t.check('restart preserves identity, descriptor revision, cursor and title', laws.restartPreservesIdentityAndCursor)
}

t.section('§4 — the review mirror: folios reach the inbox + the activity feed')
{
  activity._resetActivityFeedForTesting()
  const created = reviewStore.createReviewArtifact({
    kind: 'plan',
    title: 'mirror this review',
    producer: { sessionId: 'g-parent' },
    workspace: { roots: [process.cwd()] },
    body: { kind: 'plan', markdown: '# plan' },
    initialStatus: 'ready-for-review',
  })
  t.check('the fixture artifact created ready-for-review', created.ok === true)
  const artifactId = created.ok ? created.value.id : ''
  // The mirror is fire-and-forget — poll the main conversation directly.
  let openEvent = false
  for (let i = 0; i < 200 && !openEvent; i++) {
    const c = await conversations.conversationOf(conversations.MAIN_CONVERSATION_ID)
    openEvent =
      c?.events.some(
        e =>
          e.kind === 'review-request' &&
          e.ref === `mercury://artifact/${artifactId}` &&
          e.requiresResolution === true &&
          e.resolvedAtMs === undefined,
      ) === true
    if (!openEvent) await new Promise(r => setTimeout(r, 10))
  }
  t.check('ready-for-review appends ONE unresolved review-request on the main thread', openEvent)
  const inboxMod = await import('../../src/services/crew/inbox.ts')
  const mainConv = await conversations.conversationOf(conversations.MAIN_CONVERSATION_ID)
  t.check(
    'the inbox holds the thread ready-to-review',
    mainConv !== null && inboxMod.deriveInboxRow(mainConv, 0).bucket === 'ready-to-review',
  )
  const decided = reviewStore.setReviewArtifactStatus({ id: artifactId, version: 1, status: 'accepted' })
  t.check('the decision applies', decided.ok === true)
  let resolved = false
  for (let i = 0; i < 200 && !resolved; i++) {
    const c = await conversations.conversationOf(conversations.MAIN_CONVERSATION_ID)
    const ev = c?.events.find(
      e => e.kind === 'review-request' && e.ref === `mercury://artifact/${artifactId}`,
    )
    resolved = ev?.resolvedAtMs !== undefined
    if (!resolved) await new Promise(r => setTimeout(r, 10))
  }
  t.check('the decision RESOLVES the review-request event', resolved)
  let activityRow = false
  for (let i = 0; i < 200 && !activityRow; i++) {
    const rows = activity.activityRows(activity.cachedActivityFeed())
    activityRow = rows.some(r => r.class === 'artifact' && /mirror this review/.test(r.objectLabel))
    if (!activityRow) await new Promise(r => setTimeout(r, 10))
  }
  t.check('the review milestone lands as an artifact-class activity row (never unknown)', activityRow)
}

t.finish('prove-graph-continuity')
