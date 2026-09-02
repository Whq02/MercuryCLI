// resources/adapters/lane — bounded side lanes + handoffs
// (mercury://lane/<id>). Registered from the contextLanes slice.

import { lanesEnabled, listLanes, readLane } from '../../contextLanes/lanes.js'
import { registerResourceAdapter } from '../registry.js'
import {
  formatRef,
  type ParsedRef,
  type ResourceAdapter,
  type ResourceResult,
} from '../contracts.js'

export const laneAdapter: ResourceAdapter = {
  kind: 'lane',
  describe: 'bounded side lanes + typed handoffs (mercury://lane/<id>)',
  async resolve(ref: ParsedRef): Promise<ResourceResult> {
    if (!lanesEnabled()) {
      return { state: 'unavailable', note: 'side lanes are disabled (MERCURY_LANES=0)' }
    }
    if (ref.id === '') {
      const lanes = listLanes()
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://lane',
          kind: 'lane',
          title: 'side lanes',
          summary: `${lanes.length} lane(s) · ${lanes.filter(l => l.status === 'active').length} active`,
          mutable: true,
          children: lanes.slice(0, 50).map(l => ({
            ref: formatRef('lane', l.id),
            title: `${l.id} (${l.status})`,
            summary: l.goal.slice(0, 100),
          })),
        },
      }
    }
    const lane = readLane(ref.id)
    if (!lane) return { state: 'absent', note: `no lane '${ref.id}'` }
    const h = lane.handoff
    return {
      state: 'ok',
      resource: {
        ref: ref.canonical,
        kind: 'lane',
        title: `${lane.id} (${lane.status})`,
        summary: `${lane.goal.slice(0, 120)} · parent ${lane.parentSessionId.slice(0, 8)} · child ${lane.childSessionId.slice(0, 8)}`,
        version: `r${lane.boundaryRevision}-${lane.status}`,
        mutable: true,
        text: [
          `goal: ${lane.goal}`,
          `status: ${lane.status}`,
          `parent session: ${lane.parentSessionId}`,
          `child session: ${lane.childSessionId} (resume: claude -r ${lane.childSessionId})`,
          `created: ${new Date(lane.createdAt).toISOString()}`,
          `excluded from the parent: ${lane.excludedState.join('; ')}`,
          ...(h
            ? [
                '',
                `handoff (${h.promoted ? 'promoted' : 'NOT yet promoted'}):`,
                `  answer: ${h.answer}`,
                ...(h.findings.length > 0 ? [`  findings: ${h.findings.join(' · ')}`] : []),
                `  changed (observed): ${h.changedPaths.join(', ') || 'none'}`,
                ...(h.unresolved.length > 0 ? [`  unresolved: ${h.unresolved.join(' · ')}`] : []),
              ]
            : []),
        ].join('\n'),
        structured: {
          id: lane.id,
          status: lane.status,
          goal: lane.goal,
          promoted: h?.promoted ?? null,
        },
      },
    }
  },
}

registerResourceAdapter(laneAdapter)
