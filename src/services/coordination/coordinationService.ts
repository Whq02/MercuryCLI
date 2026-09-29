
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
import { CREW_LEAD_NAME } from '../../utils/swarm/constants.js'
import { listIncomingHandoffs } from '../../utils/swarm/handoff.js'
import { claimLease, listLeases, releaseLease, sweepExpiredLeases } from '../../utils/swarm/leaseGlob.js'
import { getRoomHealth } from '../../utils/swarm/roomHealth.js'
import {
  checkBroadcastAllowed,
  checkBroadcastFairness,
  listOpenQuestions,
} from '../../utils/swarm/sendMessageGovernance.js'
import { readCrewFileAsync } from '../../utils/swarm/crewHelpers.js'
import { getAgentStatuses, listTasks } from '../../utils/tasks.js'
import { getCrewmateColor, resolveCoordAgentId, resolveLeadAwareCrewName } from '../../utils/crewmate.js'
import { isStructuredProtocolMessage, readUnreadMessages, writeToMailbox } from '../../utils/crewmateMailbox.js'

export const NOT_IN_CREW =
  'Not part of a crew — the coordination tools have nothing to act on. ' +
  'Start or join a crew first (or launch with the --team-name identity arguments).'

export interface CoordinationContext {
  crew: string
  agentId: string
}

export interface NotInCrew {
  ok: false
  reason: 'NOT_IN_CREW'
  message: string
}

export const notInCrew = (): NotInCrew => ({ ok: false, reason: 'NOT_IN_CREW', message: NOT_IN_CREW })

export function resolveCoordinationContext(crewContext?: { teamName: string } | null): CoordinationContext | null {
  const crew = resolveLeadAwareCrewName(crewContext ?? undefined) ?? null
  if (!crew) return null
  return { crew, agentId: resolveCoordAgentId() }
}


export type LeaseClaimResult =
  | { ok: true; agentId: string; globs: string[]; ts: string }
  | { ok: false; conflict: { agentId: string; glob: string }; message: string }

export async function claimLeases(ctx: CoordinationContext, globs: string[]): Promise<LeaseClaimResult> {
  const result = await claimLease(ctx.crew, ctx.agentId, globs, { base: getProjectRoot() })
  if (result.ok) return { ok: true, agentId: ctx.agentId, globs: result.lease.globs, ts: result.lease.ts }
  return {
    ok: false,
    conflict: result.conflict,
    message: `Conflict: ${result.conflict.agentId} already holds ${result.conflict.glob}.`,
  }
}

export async function releaseLeases(ctx: CoordinationContext): Promise<{ ok: true; agentId: string; released: boolean }> {
  const released = await releaseLease(ctx.crew, ctx.agentId)
  return { ok: true, agentId: ctx.agentId, released }
}

export interface LeaseRow {
  agentId: string
  globs: string[]
  ts: string
}

export async function listCrewLeases(ctx: CoordinationContext): Promise<LeaseRow[]> {
  await sweepExpiredLeases(ctx.crew).catch(() => 0)
  const leases = await listLeases(ctx.crew)
  return leases.map(l => ({ agentId: l.agentId, globs: l.globs, ts: l.ts }))
}


export interface CrewBrief {
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

export const EMPTY_BRIEF: CrewBrief = {
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

export async function crewBrief(ctx: CoordinationContext | null): Promise<CrewBrief> {
  if (!ctx) return { ...EMPTY_BRIEF }
  const { crew, agentId } = ctx
  const [allTasks, liveTasks, unread, statuses, leases, liveBusy, openQs, roomHealth, incomingHandoffs] = await Promise.all([
    listTasks(crew).catch(() => []),
    listLiveTasks(crew).catch((): LiveCommsTaskV1[] => []),
    readUnreadMessages(agentId, crew).catch(() => []),
    getAgentStatuses(crew).catch(() => null),
    listLeases(crew).catch(() => []),
    listLiveBusy(crew).catch((): LiveCommsBusyV1[] => []),
    listOpenQuestions(agentId, crew).catch(() => []),
    getRoomHealth(crew).catch(() => ({ agents: [], conflicts: [] })),
    listIncomingHandoffs(agentId, crew).catch(() => []),
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
  const roster: CrewBrief['roster'] = (statuses ?? []).map(s => {
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
  const health: CrewBrief['health'] = roomHealth.agents.map(a => {
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
    teamName: crew,
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
  const { crew, agentId: sender } = ctx
  const crewFile = await readCrewFileAsync(crew)
  if (!crewFile) return { ok: false, refused: `Crew "${crew}" does not exist.` }
  const envelope = () => ({
    from: sender,
    text: message,
    summary,
    timestamp: new Date().toISOString(),
    color: getCrewmateColor(),
  })
  if (to === '*') {
    const senderIsLead =
      sender.toLowerCase() === CREW_LEAD_NAME.toLowerCase() ||
      crewFile.members.some(m => m.name === sender && m.agentId === crewFile.leadAgentId)
    const broadcastDenied = checkBroadcastAllowed(crewFile, senderIsLead)
    if (broadcastDenied) return { ok: false, refused: broadcastDenied }
    const fairnessDenied = await checkBroadcastFairness(sender, crewFile.governance, crew)
    if (fairnessDenied) return { ok: false, refused: fairnessDenied }
    const recipients = crewFile.members.map(m => m.name).filter(n => n.toLowerCase() !== sender.toLowerCase())
    let failed = 0
    for (const recipient of recipients) {
      const delivered = await writeToMailbox(recipient, envelope(), crew)
      if (!delivered) failed++
    }
    return {
      ok: failed === 0,
      broadcast: true,
      recipients,
      failed,
      message:
        recipients.length === 0
          ? 'No crewmates to broadcast to.'
          : failed === 0
            ? `Broadcast to ${recipients.length} crewmate(s).`
            : `Broadcast reached ${recipients.length - failed}/${recipients.length} crewmate(s); ${failed} write(s) failed.`,
    }
  }
  const isMember = crewFile.members.some(m => m.name.toLowerCase() === to.toLowerCase())
  if (!isMember) return { ok: false, refused: `"${to}" is not on crew "${crew}" — not sent (no dead-inbox write).` }
  const delivered = await writeToMailbox(to, envelope(), crew)
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
      const task = await upsertLiveTask(ctx.crew, { ...writes.task, createdBy: ctx.agentId })
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
      await setLiveBusy(ctx.crew, ctx.agentId, busy, doing)
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
