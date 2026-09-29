
import { isInProcessCrewmateTask } from '../../../tasks/InProcessCrewmateTask/types.js'
import { CREW_LEAD_NAME } from '../../../utils/swarm/constants.js'
import { readCoordinationRoster, resolveCoordinationContext, type CoordinationRosterRow } from '../../coordination/coordinationService.js'
import { crewDirectoryEnabled, listAgentBindings, type CrewAgentId } from '../../crew/identity.js'
import { resolveCrewSnapshot, type CrewMemberV1 } from '../../crew/projection.js'
import type { ParsedRef, ResourceAdapter, ResourceContext, ResourceResult, ResourceChild } from '../contracts.js'

type RosterMember = CoordinationRosterRow & {
  state: 'running' | 'idle' | 'paused' | 'stopped'
  ref: string
  projection?: CrewMemberV1
}

async function rosterOf(ctx: ResourceContext, directory: readonly CrewMemberV1[]): Promise<{ crew: string; members: RosterMember[] } | null> {
  const app = ctx.getAppState?.() as { crewContext?: { crewName: string }; tasks?: Record<string, unknown> } | undefined
  const coordination = resolveCoordinationContext(app?.crewContext)
  if (!coordination) return null
  const roster = await readCoordinationRoster(coordination.crew)
  if (roster === null) throw new Error(`the roster for crew '${coordination.crew}' is absent or unreadable`)
  const byBinding = new Map<string, CrewMemberV1>()
  for (const member of directory) {
    for (const binding of await listAgentBindings(member.agentId)) {
      byBinding.set(`${binding.bindingKind}:${binding.bindingId}`, member)
    }
  }
  const tasks = Object.values(app?.tasks ?? {}).filter(isInProcessCrewmateTask)
  const members = roster.map((row): RosterMember => {
    const task = tasks.find(t => t.identity.agentId === row.agentId && t.status === 'running')
    const projection = byBinding.get(`native:crew:${row.agentId}`)
      ?? (task ? byBinding.get(`native:subagent:${task.transcriptAgentId ?? task.id}`) : undefined)
      ?? (row.name === CREW_LEAD_NAME ? byBinding.get('principal:agent-mercury') : undefined)
    return {
      ...row,
      state: row.status === 'stopped' ? 'stopped' : task?.paused ? 'paused' : row.status === 'busy' ? 'running' : 'idle',
      ref: `mercury://crew/member/${encodeURIComponent(row.agentId)}`,
      ...(projection ? { projection } : {}),
    }
  })
  return { crew: coordination.crew, members }
}

function rosterLine(member: RosterMember): string {
  const type = member.agentType ? ` <${member.agentType}>` : ''
  const status = member.doing !== undefined ? `${member.status}: ${member.doing}` : member.status
  const projection = member.projection
  return [
    `- ${member.name}${type} [${status}]`,
    `state: ${member.state}`,
    `cwd: ${member.cwd ?? '(not recorded)'}`,
    ...(member.worktree ? [`worktree: ${member.worktree}`] : []),
    ...(projection ? [`presence: ${projection.presence.state}`] : []),
    ...(projection?.lifecycle ? [`lifecycle: ${projection.lifecycle.state}`] : []),
    ...(projection?.focus ? [`focus: ${projection.focus.label}`] : []),
  ].join(' · ')
}

function rosterChildren(members: readonly RosterMember[]): ResourceChild[] {
  return members.map(member => ({ ref: member.ref, title: member.name, summary: rosterLine(member) }))
}

function memberLine(m: CrewMemberV1): string {
  const lifecycle = m.lifecycle ? ` · ${m.lifecycle.state}` : ''
  const focus = m.focus ? ` · ${m.focus.label}` : ''
  return `${m.label} — ${m.presence.state}${lifecycle}${focus}`
}

export const crewAdapter: ResourceAdapter = {
  kind: 'crew',
  describe: 'the crew roster (every member and state, including stopped; member/<id> and agent/<id> detail)',
  async resolve(ref: ParsedRef, ctx: ResourceContext): Promise<ResourceResult> {
    if (!crewDirectoryEnabled()) {
      return { state: 'unavailable', note: 'the crew directory is disabled (MERCURY_CREW_DIRECTORY=0)' }
    }
    const snap = await resolveCrewSnapshot()
    if (!snap) {
      return { state: 'unavailable', note: 'the crew projection could not be resolved' }
    }
    const sep = ref.id.indexOf('/')
    const head = sep < 0 ? ref.id : ref.id.slice(0, sep)
    const tail = sep < 0 ? '' : ref.id.slice(sep + 1)
    if (head === '' || head === 'member') {
      let roster: Awaited<ReturnType<typeof rosterOf>>
      try {
        roster = await rosterOf(ctx, snap.members)
      } catch (error) {
        return { state: 'unavailable', note: String(error) }
      }
      if (roster && head === '') {
        return {
          state: 'ok',
          resource: {
            ref: 'mercury://crew', kind: 'crew', title: 'crew',
            summary: `${roster.members.length} member(s)`,
            mutable: true,
            text: roster.members.map(rosterLine).join('\n') || '(no roster members)',
            structured: { v: 1, crew: roster.crew, sources: snap.sources, members: roster.members },
            children: rosterChildren(roster.members),
          },
        }
      }
      if (head === 'member') {
        const member = roster?.members.find(row => row.ref === `mercury://crew/member/${tail}`)
        if (!member) return { state: 'absent', note: `no roster member '${tail}' in this crew` }
        return {
          state: 'ok',
          resource: {
            ref: member.ref, kind: 'crew', title: member.name, summary: member.status,
            mutable: true, text: rosterLine(member), structured: member,
            sourceRefs: member.projection?.refs,
          },
        }
      }
    }
    if (ref.id === '' || head === '') {
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://crew',
          kind: 'crew',
          title: 'crew',
          summary: `${snap.members.length} member(s)`,
          version: String(snap.version),
          mutable: true,
          text: snap.members.map(memberLine).join('\n') || '(no registered members)',
          structured: {
            v: snap.v,
            refreshedAt: snap.refreshedAt,
            sources: snap.sources,
            members: snap.members,
          },
          children: snap.members.map(m => ({
            ref: m.refs[0]!,
            title: m.label,
            summary: memberLine(m),
          })) satisfies ResourceChild[],
        },
      }
    }
    if (head === 'agent') {
      const agentId = tail
      const member = snap.members.find(m => m.agentId === agentId)
      if (!member) {
        return { state: 'absent', note: `no crew member '${agentId}' in the registry` }
      }
      const bindings = await listAgentBindings(agentId as CrewAgentId)
      return {
        state: 'ok',
        resource: {
          ref: `mercury://crew/agent/${agentId}`,
          kind: 'crew',
          title: member.label,
          summary: memberLine(member),
          version: String(snap.version),
          mutable: true,
          text: [
            memberLine(member),
            `presence: ${member.presence.state} (${member.presence.source})`,
            member.lifecycle ? `lifecycle: ${member.lifecycle.state} (${member.lifecycle.source})` : 'lifecycle: (no owner vocabulary)',
            member.focus ? `focus: ${member.focus.label} (${member.focus.source})` : 'focus: (none recorded)',
            `roles: ${member.roles.map(r => r.role).join(', ') || '(none)'}`,
            `sessions: ${member.sessions.length}`,
            `bindings: ${bindings.map(b => `${b.bindingKind}:${b.bindingId}`).join(' · ') || '(none)'}`,
          ].join('\n'),
          structured: { member, bindings },
          sourceRefs: member.refs,
        },
      }
    }
    return { state: 'absent', note: `unknown crew path '${ref.id}' (use '', member/<id> or agent/<id>)` }
  },
  async list(ctx: ResourceContext): Promise<ResourceChild[]> {
    if (!crewDirectoryEnabled()) return []
    const snap = await resolveCrewSnapshot()
    const roster = await rosterOf(ctx, snap?.members ?? [])
    if (roster) return rosterChildren(roster.members)
    return (snap?.members ?? []).map(m => ({
      ref: m.refs[0]!,
      title: m.label,
      summary: memberLine(m),
    }))
  },
}
