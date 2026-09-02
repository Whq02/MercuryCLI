// ============================================================================
//  resources/adapters/crew — mercury://crew.
//
//  The living-crew directory over the ONE teammate projection:
//    mercury://crew                  — the member listing (identity + presence
//                                      + lifecycle + focus, source health)
//    mercury://crew/agent/<cw-id>    — one member's full projection (bindings
//                                      ride the registry; refs deep-link the
//                                      owning surfaces, never clone them)
//
//  One-shot resolves ride resolveCrewSnapshot() — a bridge process never arms
//  the engine (no timer for one read; the workbench adapter precedent).
// ============================================================================

import { crewDirectoryEnabled, listAgentBindings, type CrewAgentId } from '../../crew/identity.js'
import { resolveCrewSnapshot, type CrewMemberV1 } from '../../crew/projection.js'
import type { ParsedRef, ResourceAdapter, ResourceContext, ResourceResult, ResourceChild } from '../contracts.js'

function memberLine(m: CrewMemberV1): string {
  const lifecycle = m.lifecycle ? ` · ${m.lifecycle.state}` : ''
  const focus = m.focus ? ` · ${m.focus.label}` : ''
  return `${m.label} — ${m.presence.state}${lifecycle}${focus}`
}

export const crewAdapter: ResourceAdapter = {
  kind: 'crew',
  describe: 'the living-crew directory (members · presence · lifecycle · focus; agent/<id> detail)',
  async resolve(ref: ParsedRef, _ctx: ResourceContext): Promise<ResourceResult> {
    if (!crewDirectoryEnabled()) {
      return { state: 'unavailable', note: 'the crew directory is disabled (MERCURY_CREW_DIRECTORY=0)' }
    }
    const snap = await resolveCrewSnapshot()
    if (!snap) {
      return { state: 'unavailable', note: 'the crew projection could not be resolved' }
    }
    // Prefix parse — a mercury:// ref id is a PROTOCOL path ('' or
    // 'agent/<id>'), never an OS path (the win32-seam ratchet stays clean).
    const sep = ref.id.indexOf('/')
    const head = sep < 0 ? ref.id : ref.id.slice(0, sep)
    const tail = sep < 0 ? '' : ref.id.slice(sep + 1)
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
    return { state: 'absent', note: `unknown crew path '${ref.id}' (use '' or agent/<id>)` }
  },
  async list(): Promise<ResourceChild[]> {
    if (!crewDirectoryEnabled()) return []
    const snap = await resolveCrewSnapshot()
    return (snap?.members ?? []).map(m => ({
      ref: m.refs[0]!,
      title: m.label,
      summary: memberLine(m),
    }))
  },
}
