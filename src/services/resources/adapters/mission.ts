
import { missionEnabled } from '../../mission/contracts.js'
import { buildMissionRow, gatherMissionView } from '../../mission/projection.js'
import { registerResourceAdapter } from '../registry.js'
import type { ResourceAdapter } from '../contracts.js'

const missionAdapter: ResourceAdapter = {
  kind: 'mission',
  describe: "the composed mission view — goal · the session's model · fingerprint · evidence refs",
  async resolve(ref, _ctx) {
    if (!missionEnabled()) {
      return { state: 'unavailable', note: 'MERCURY_MISSION is disabled' }
    }
    if (ref.id !== 'current' && ref.id !== '') {
      return { state: 'absent', note: 'only mercury://mission/current exists' }
    }
    const view = await gatherMissionView()
    if (view === null) {
      return {
        state: 'absent',
        note: 'no active mission — no substantive run objective and no armed mission card',
      }
    }
    if (ref.selectors.child === 'record') {
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://mission/current?child=record',
          kind: 'mission',
          title: 'mission record ' + view.missionId,
          summary: 'the full typed MissionView composition record',
          mutable: true,
          structured: view,
          text: JSON.stringify(view, null, 2),
        },
      }
    }
    const row = buildMissionRow(view)
    return {
      state: 'ok',
      resource: {
        ref: 'mercury://mission/current',
        kind: 'mission',
        title: 'mission ' + view.missionId,
        summary: row?.line ?? 'mission view',
        mutable: true,
        version: view.missionId,
        structured: {
          missionId: view.missionId,
          goal: view.goal,
          policy: view.policy,
          outcome: view.outcome,
        },
        text: (row?.detail ?? []).join('\n'),
        children: [
          { ref: 'mercury://mission/current?child=record', title: 'record', summary: 'the full typed MissionView (JSON)' },
        ],
      },
    }
  },
}

registerResourceAdapter(missionAdapter)
