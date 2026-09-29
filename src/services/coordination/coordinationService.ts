
import { getProjectRoot } from '../../bootstrap/state.js'
import {
  listLiveBusy,
  listLiveTasks,
  setLiveBusy,
  upsertLiveTask,
  type LiveCommsBusyV1,
  type LiveCommsTaskV1,
  type LiveTaskStatus,
} from '../crew/liveComms.js'
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

export const NOT_IN_TEAM =
  'Not part of a team — the coordination tools have nothing to act on. ' +
  'Start or join a team first (or launch with the --team-name identity arguments).'

export interface CoordinationContext {
  team: string
  agentId: string
}

export interface NotInTeam {
  ok: false
  reason: 'NOT_IN_TEAM'
  message: string
}

export const notInTeam = (): NotInTeam => ({ ok: false, reason: 'NOT_IN_TEAM', message: NOT_IN_TEAM })

export function resolveCoordinationContext(teamContext?: { teamName: string } | null): CoordinationContext | null {
  const team = resolveLeadAwareTeamName(teamContext ?? undefined) ?? null
  if (!team) return null
  return { team, agentId: resolveCoordAgentId() }
}


export type LeaseClaimResult =
  | { ok: true; agentId: string; globs: string[]; ts: string }
  | { ok: false; conflict: { agentId: string; glob: string }; message: string }

export async function claimLeases(ctx: CoordinationContext, globs: string[]): Promise<LeaseClaimResult> {
  const result = await claimLease(ctx.team, ctx.agentId, globs, { base: getProjectRoot() })
  if (result.ok) return { ok: true, agentId: ctx.agentId, globs: result.lease.globs, ts: result.lease.ts }
  return {
    ok: false,
    conflict: result.conflict,
    message: `Conflict: ${result.conflict.agentId} already holds ${result.conflict.glob}.`,
  }
}

export async function releaseLeases(ctx: CoordinationContext): Promise<{ ok: true; agentId: string; released: boolean }> {
  const released = await releaseLease(ctx.team, ctx.agentId)
  return { ok: true, agentId: ctx.agentId, released }
}

export interface LeaseRow {
  agentId: string
  globs: string[]
  ts: string
}

export async function listTeamLeases(ctx: CoordinationContext): Promise<LeaseRow[]> {
  await sweepExpiredLeases(ctx.team).catch(() => 0)
  const leases = await listLeases(ctx.team)
  return leases.map(l => ({ agentId: l.agentId, globs: l.globs, ts: l.ts }))
}


export interface TeamBrief {
  teamName: string | null
  openTasks: Array<{ id: string; subject: string; status: string; owner?: string; blockedBy: string[] }>
  unreadMessages: Array<{ from: string; text: string; timestamp: string; summary?: string }>
  openQuestions: Array<{ request_id: string; from: string; text: string; summary?: string; askedAt: string }>
  roster: Array<{ name: string; agentType?: string; status: string; currentTasks: string[]; doing?: string }>
  leases: LeaseRow[]
  health: Array<{
    name: string
    agentType?: string
    state: 'idle' | 'busy' | 'drifting'
    currentTasks: string[]
    leaseAgeMs: number | null
    why: string
  }>
  conflicts: Array<{ kind: 'lease-overlap'; agents: [string, string]; detail: string }>
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

export async function teamBrief(ctx: CoordinationContext | null): Promise<TeamBrief> {
  if (!ctx) return { ...EMPTY_BRIEF }
  const { team, agentId } = ctx
  const [allTasks, liveTasks, unread, statuses, leases, liveBusy, openQs, roomHealth, incomingHandoffs] = await Promise.all([
    listTasks(team).catch(() => []),
    listLiveTasks(team).catch((): LiveCommsTaskV1[] => []),
    readUnreadMessages(agentId, team).catch(() => []),
    getAgentStatuses(team).catch(() => null),
    listLeases(team).catch(() => []),
    listLiveBusy(team).catch((): LiveCommsBusyV1[] => []),
    listOpenQuestions(agentId, team).catch(() => []),
    getRoomHealth(team).catch(() => ({ agents: [], conflicts: [] })),
    listIncomingHandoffs(agentId, team).catch(() => []),
  ])

  const resolvedTaskIds = new Set([
    ...allTasks.filter(t => t.status === 'completed').map(t => t.id),
    ...liveTasks.filter(t => t.status === 'completed').map(t => t.id),
  ])
  const openTasks = [
    ...allTasks
      .filter(t => t.status !== 'completed' && !t.metadata?._internal)
      .map(t => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        owner: t.owner,
        blockedBy: t.blockedBy.filter(id => !resolvedTaskIds.has(id)),
      })),
    ...liveTasks
      .filter(t => t.status !== 'completed')
      .map(t => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        owner: t.owner,
        blockedBy: t.blockedBy.filter(id => !resolvedTaskIds.has(id)),
      })),
  ]

  const unreadMessages = unread
    .filter(m => !isStructuredProtocolMessage(m.text))
    .map(m => ({ from: m.from, text: m.text, timestamp: m.timestamp, summary: m.summary }))

  const busyByName = new Map(liveBusy.map(b => [b.name, b] as const))
  const roster: TeamBrief['roster'] = (statuses ?? []).map(s => {
    const word = busyByName.get(s.name)
    if (word === undefined) return { name: s.name, agentType: s.agentType, status: s.status, currentTasks: s.currentTasks }
    return {
      name: s.name,
      agentType: s.agentType,
      status: word.busy ? 'busy' : s.currentTasks.length > 0 ? 'busy' : 'idle',
      currentTasks: s.currentTasks,
      ...(word.busy && word.doing !== undefined ? { doing: word.doing } : {}),
    }
  })
  const health: TeamBrief['health'] = roomHealth.agents.map(a => {
    const word = busyByName.get(a.name)
    if (word === undefined || a.state === 'drifting') {
      return { name: a.name, agentType: a.agentType, state: a.state, currentTasks: a.currentTasks, leaseAgeMs: a.leaseAgeMs, why: a.why }
    }
    if (word.busy) {
      return {
        name: a.name,
        agentType: a.agentType,
        state: 'busy',
        currentTasks: a.currentTasks,
        leaseAgeMs: a.leaseAgeMs,
        why: word.doing !== undefined ? `working — ${word.doing}` : a.state === 'busy' ? a.why : 'working — its turn is in flight',
      }
    }
    if (a.currentTasks.length > 0) {
      return { name: a.name, agentType: a.agentType, state: a.state, currentTasks: a.currentTasks, leaseAgeMs: a.leaseAgeMs, why: a.why }
    }
    return { name: a.name, agentType: a.agentType, state: 'idle', currentTasks: a.currentTasks, leaseAgeMs: a.leaseAgeMs, why: 'idle by its own word' }
  })

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
    roster,
    leases: leases.map(l => ({ agentId: l.agentId, globs: l.globs, ts: l.ts })),
    health,
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


export type SayResult =
  | { ok: boolean; broadcast: true; recipients: string[]; failed: number; message: string }
  | { ok: boolean; broadcast: false; to: string; message: string }
  | { ok: false; refused: string }

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

export interface LiveCommsWrites {
  say?: { to: string; message: string; summary?: string }
  task?: {
    id?: string
    subject?: string
    detail?: string
    status?: LiveTaskStatus
    owner?: string
    blockedBy?: string[]
  }
  claim?: { paths: string[] }
  release?: boolean
  busy?: boolean | { busy: boolean; doing?: string }
}

export interface LiveCommsReceipt {
  kind: 'message' | 'task' | 'claim' | 'release' | 'busy'
  ok: boolean
  detail: string
}

export async function writeLiveComms(ctx: CoordinationContext, writes: LiveCommsWrites): Promise<LiveCommsReceipt[]> {
  const receipts: LiveCommsReceipt[] = []
  if (writes.task !== undefined) {
    try {
      const task = await upsertLiveTask(ctx.team, { ...writes.task, createdBy: ctx.agentId })
      if (task === null) receipts.push({ kind: 'task', ok: false, detail: 'a task needs a subject (or the id of an existing task)' })
      else receipts.push({ kind: 'task', ok: true, detail: `task #${task.id} [${task.status}] ${task.subject}${task.owner ? ` (${task.owner})` : ''}` })
    } catch (error) {
      receipts.push({ kind: 'task', ok: false, detail: `the task could not be written: ${String(error)}` })
    }
  }
  if (writes.claim !== undefined) {
    try {
      const result = await claimLeases(ctx, writes.claim.paths)
      if (result.ok) receipts.push({ kind: 'claim', ok: true, detail: `${ctx.agentId} holds ${result.globs.join(', ') || '(nothing)'}` })
      else receipts.push({ kind: 'claim', ok: false, detail: result.message })
    } catch (error) {
      receipts.push({ kind: 'claim', ok: false, detail: `the claim could not be written: ${String(error)}` })
    }
  }
  if (writes.release === true) {
    try {
      const result = await releaseLeases(ctx)
      receipts.push({ kind: 'release', ok: true, detail: result.released ? `${ctx.agentId} released its claims` : `${ctx.agentId} held no claim` })
    } catch (error) {
      receipts.push({ kind: 'release', ok: false, detail: `the release could not be written: ${String(error)}` })
    }
  }
  if (writes.busy !== undefined) {
    const busy = typeof writes.busy === 'boolean' ? writes.busy : writes.busy.busy
    const doing = typeof writes.busy === 'boolean' ? undefined : writes.busy.doing
    try {
      await setLiveBusy(ctx.team, ctx.agentId, busy, doing)
      receipts.push({ kind: 'busy', ok: true, detail: busy ? `${ctx.agentId} is busy${doing !== undefined ? `: ${doing}` : ''}` : `${ctx.agentId} is idle` })
    } catch (error) {
      receipts.push({ kind: 'busy', ok: false, detail: `the busy flag could not be written: ${String(error)}` })
    }
  }
  if (writes.say !== undefined) {
    try {
      const result = await say(ctx, writes.say.to, writes.say.message, writes.say.summary)
      if ('refused' in result) receipts.push({ kind: 'message', ok: false, detail: result.refused })
      else receipts.push({ kind: 'message', ok: result.ok, detail: result.message })
    } catch (error) {
      receipts.push({ kind: 'message', ok: false, detail: `the message could not be written: ${String(error)}` })
    }
  }
  return receipts
}
