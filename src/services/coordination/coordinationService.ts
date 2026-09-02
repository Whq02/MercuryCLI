// ============================================================================
//  services/coordination/coordinationService — Mercury's coordination
//  substrate as ONE typed, in-engine service.
//
//  The substrate is native: file leases (leaseGlob), the team brief (tasks ·
//  mailbox · roster · health · conflicts · handoffs · open questions), and
//  team messaging under the broadcast governance.
//  Every projection of it — the in-process MCP coordination server that agents
//  call as `mcp__mercury__*`, the TeamBrief tool the model calls natively —
//  is a THIN adapter over these functions: one consolidation, one identity
//  law, one solo contract, so two projections can never disagree.
//
//  IDENTITY: the coordination agentId is the teammate NAME (the lead-aware
//  resolver shared with the lease guard); the team is resolveLeadAwareTeamName
//  (an AppState teamContext, when the caller has one, feeds it). Outside a
//  team every verb answers the SOLO contract — `{ ok: false, reason:
//  'NOT_IN_TEAM' }` for the acting verbs, an empty brief with `teamName:
//  null` for the read — never a throw.
// ============================================================================

import { getProjectRoot } from '../../bootstrap/state.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { listIncomingHandoffs } from '../../utils/swarm/handoff.js'
import { claimLease, listLeases, releaseLease, sweepExpiredLeases } from '../../utils/swarm/leaseGlob.js'
import { getRoomHealth } from '../../utils/swarm/roomHealth.js'
import {
  checkBroadcastAllowed,
  checkBroadcastFairness,
  listOpenQuestions,
} from '../../utils/swarm/sendMessageGovernance.js'
import { readTeamFileAsync } from '../../utils/swarm/teamHelpers.js'
import { getAgentStatuses, listTasks } from '../../utils/tasks.js'
import { getTeammateColor, resolveCoordAgentId, resolveLeadAwareTeamName } from '../../utils/teammate.js'
import { isStructuredProtocolMessage, readUnreadMessages, writeToMailbox } from '../../utils/teammateMailbox.js'

/** The one solo message every projection speaks. */
export const NOT_IN_TEAM =
  'Not part of a team — the coordination tools have nothing to act on. ' +
  'Start or join a team first (or launch with the --team-name identity arguments).'

/** Who is acting, on which team. */
export interface CoordinationContext {
  team: string
  agentId: string
}

/** The solo contract of every acting verb. */
export interface NotInTeam {
  ok: false
  reason: 'NOT_IN_TEAM'
  message: string
}

export const notInTeam = (): NotInTeam => ({ ok: false, reason: 'NOT_IN_TEAM', message: NOT_IN_TEAM })

/**
 * Resolve the acting context — the lead-aware team (an AppState teamContext
 * feeds the lead's own session) and the coordination identity. `null` when
 * the session is not in a team.
 */
export function resolveCoordinationContext(teamContext?: { teamName: string } | null): CoordinationContext | null {
  const team = resolveLeadAwareTeamName(teamContext ?? undefined) ?? null
  if (!team) return null
  return { team, agentId: resolveCoordAgentId() }
}

// ── leases ──────────────────────────────────────────────────────────────────

export type LeaseClaimResult =
  | { ok: true; agentId: string; globs: string[]; ts: string }
  | { ok: false; conflict: { agentId: string; glob: string }; message: string }

/** Claim (or renew) leases over repo-relative globs; an empty set releases. */
export async function claimLeases(ctx: CoordinationContext, globs: string[]): Promise<LeaseClaimResult> {
  // Stable base so the claim shares the guard's namespace across cwd/worktree.
  const result = await claimLease(ctx.team, ctx.agentId, globs, { base: getProjectRoot() })
  if (result.ok) return { ok: true, agentId: ctx.agentId, globs: result.lease.globs, ts: result.lease.ts }
  return {
    ok: false,
    conflict: result.conflict,
    message: `Conflict: ${result.conflict.agentId} already holds ${result.conflict.glob}.`,
  }
}

/** Release every lease this agent holds (idempotent). */
export async function releaseLeases(ctx: CoordinationContext): Promise<{ ok: true; agentId: string; released: boolean }> {
  const released = await releaseLease(ctx.team, ctx.agentId)
  return { ok: true, agentId: ctx.agentId, released }
}

export interface LeaseRow {
  agentId: string
  globs: string[]
  ts: string
}

/** The team's current (non-expired) leases; expired ones are swept first. */
export async function listTeamLeases(ctx: CoordinationContext): Promise<LeaseRow[]> {
  await sweepExpiredLeases(ctx.team).catch(() => 0)
  const leases = await listLeases(ctx.team)
  return leases.map(l => ({ agentId: l.agentId, globs: l.globs, ts: l.ts }))
}

// ── the brief ───────────────────────────────────────────────────────────────

export interface TeamBrief {
  teamName: string | null
  openTasks: Array<{ id: string; subject: string; status: string; owner?: string; blockedBy: string[] }>
  unreadMessages: Array<{ from: string; text: string; timestamp: string; summary?: string }>
  /** Unanswered questions addressed to me. */
  openQuestions: Array<{ request_id: string; from: string; text: string; summary?: string; askedAt: string }>
  roster: Array<{ name: string; agentType?: string; status: string; currentTasks: string[] }>
  leases: LeaseRow[]
  /** Derived per-agent health (roomHealth's one derivation). */
  health: Array<{
    name: string
    agentType?: string
    state: 'idle' | 'busy' | 'drifting'
    currentTasks: string[]
    leaseAgeMs: number | null
    why: string
  }>
  /** Overlapping leases across agents. */
  conflicts: Array<{ kind: 'lease-overlap'; agents: [string, string]; detail: string }>
  /** Incoming handoffs addressed to me; unverified ones are flagged. */
  handoffs: Array<{
    id: string
    from: string
    status: string
    summary: string
    verified: boolean
    unverifiedReason?: string
    evidenceCount: number
    sentAt: string
  }>
}

export const EMPTY_BRIEF: TeamBrief = {
  teamName: null,
  openTasks: [],
  unreadMessages: [],
  openQuestions: [],
  roster: [],
  leases: [],
  health: [],
  conflicts: [],
  handoffs: [],
}

/**
 * The consolidated team brief — THE one read of the team state. `ctx === null`
 * (solo) answers the empty brief with `teamName: null`. Every facet fails
 * open on its own: one substrate's read failing empties its section, never
 * the brief.
 */
export async function teamBrief(ctx: CoordinationContext | null): Promise<TeamBrief> {
  if (!ctx) return { ...EMPTY_BRIEF }
  const { team, agentId } = ctx
  const [allTasks, unread, statuses, leases, openQs, roomHealth, incomingHandoffs] = await Promise.all([
    listTasks(team).catch(() => []),
    readUnreadMessages(agentId, team).catch(() => []),
    getAgentStatuses(team).catch(() => null),
    listLeases(team).catch(() => []),
    listOpenQuestions(agentId, team).catch(() => []),
    getRoomHealth(team).catch(() => ({ agents: [], conflicts: [] })),
    listIncomingHandoffs(agentId, team).catch(() => []),
  ])

  const resolvedTaskIds = new Set(allTasks.filter(t => t.status === 'completed').map(t => t.id))
  const openTasks = allTasks
    .filter(t => t.status !== 'completed' && !t.metadata?._internal)
    .map(t => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      owner: t.owner,
      blockedBy: t.blockedBy.filter(id => !resolvedTaskIds.has(id)),
    }))

  // Structured protocol messages (permission/shutdown/…) are routed by
  // handlers, never brief content.
  const unreadMessages = unread
    .filter(m => !isStructuredProtocolMessage(m.text))
    .map(m => ({ from: m.from, text: m.text, timestamp: m.timestamp, summary: m.summary }))

  return {
    teamName: team,
    openTasks,
    unreadMessages,
    openQuestions: openQs.map(q => ({
      request_id: q.request_id,
      from: q.from,
      text: q.text,
      summary: q.summary,
      askedAt: q.askedAt,
    })),
    roster: (statuses ?? []).map(s => ({
      name: s.name,
      agentType: s.agentType,
      status: s.status,
      currentTasks: s.currentTasks,
    })),
    leases: leases.map(l => ({ agentId: l.agentId, globs: l.globs, ts: l.ts })),
    health: roomHealth.agents.map(a => ({
      name: a.name,
      agentType: a.agentType,
      state: a.state,
      currentTasks: a.currentTasks,
      leaseAgeMs: a.leaseAgeMs,
      why: a.why,
    })),
    conflicts: roomHealth.conflicts.map(c => ({ kind: c.kind, agents: c.agents, detail: c.detail })),
    handoffs: incomingHandoffs.map(h => ({
      id: h.id,
      from: h.from,
      status: h.status,
      summary: h.summary,
      verified: h.verified,
      unverifiedReason: h.unverifiedReason,
      evidenceCount: h.evidenceRefs.length,
      sentAt: h.sentAt,
    })),
  }
}

// ── messaging ───────────────────────────────────────────────────────────────

export type SayResult =
  | { ok: boolean; broadcast: true; recipients: string[]; failed: number; message: string }
  | { ok: boolean; broadcast: false; to: string; message: string }
  /** A refusal the projections surface as a tool error (never a dead-inbox write). */
  | { ok: false; refused: string }

/**
 * Message a teammate by name, or broadcast with `to === '*'`. Writes to the
 * team mailbox the way SendMessage does, under the same governance: the
 * lead-enable gate and the turn-fairness gate for broadcasts; a roster check
 * for a DM. A bus write is not a delivery receipt — the result honours
 * writeToMailbox's boolean.
 */
export async function say(
  ctx: CoordinationContext,
  to: string,
  message: string,
  summary?: string,
): Promise<SayResult> {
  const { team, agentId: sender } = ctx
  const teamFile = await readTeamFileAsync(team)
  if (!teamFile) return { ok: false, refused: `Team "${team}" does not exist.` }
  const envelope = () => ({
    from: sender,
    text: message,
    summary,
    timestamp: new Date().toISOString(),
    color: getTeammateColor(),
  })
  if (to === '*') {
    // The lead is resolved like resolveDirectActor: the lead name or the leadAgentId.
    const senderIsLead =
      sender.toLowerCase() === TEAM_LEAD_NAME.toLowerCase() ||
      teamFile.members.some(m => m.name === sender && m.agentId === teamFile.leadAgentId)
    const broadcastDenied = checkBroadcastAllowed(teamFile, senderIsLead)
    if (broadcastDenied) return { ok: false, refused: broadcastDenied }
    const fairnessDenied = await checkBroadcastFairness(sender, teamFile.governance, team)
    if (fairnessDenied) return { ok: false, refused: fairnessDenied }
    const recipients = teamFile.members.map(m => m.name).filter(n => n.toLowerCase() !== sender.toLowerCase())
    let failed = 0
    for (const recipient of recipients) {
      const delivered = await writeToMailbox(recipient, envelope(), team)
      if (!delivered) failed++
    }
    return {
      ok: failed === 0,
      broadcast: true,
      recipients,
      failed,
      message:
        recipients.length === 0
          ? 'No teammates to broadcast to.'
          : failed === 0
            ? `Broadcast to ${recipients.length} teammate(s).`
            : `Broadcast reached ${recipients.length - failed}/${recipients.length} teammate(s); ${failed} write(s) failed.`,
    }
  }
  // A typo'd / non-member recipient must not create a dead inbox nobody reads.
  const isMember = teamFile.members.some(m => m.name.toLowerCase() === to.toLowerCase())
  if (!isMember) return { ok: false, refused: `"${to}" is not on team "${team}" — not sent (no dead-inbox write).` }
  const delivered = await writeToMailbox(to, envelope(), team)
  return {
    ok: delivered,
    broadcast: false,
    to,
    message: delivered ? `Message sent to ${to}'s inbox.` : `Message to ${to} could NOT be delivered (write failed).`,
  }
}
