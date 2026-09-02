// ============================================================================
//  resources/adapters/mission — mercury://mission/current.
//    mercury://mission/current                — the composed MissionView
//    mercury://mission/current?child=plans    — route-plan/node references
//    mercury://mission/current?child=record   — the full typed record (JSON)
//
// The HEADLESS mission surface (brief): machine consumers get the typed
//  composition record without interactive chrome. Projection-only — every
//  fact referenced here is owned elsewhere (run kernel · route store ·
//  project-intel snapshot · memory refs · execution plane · verify evidence).
// ============================================================================

import { missionEnabled } from '../../mission/contracts.js'
import { buildMissionRow, gatherMissionView } from '../../mission/projection.js'
import { registerResourceAdapter } from '../registry.js'
import type { ResourceAdapter } from '../contracts.js'

const missionAdapter: ResourceAdapter = {
  kind: 'mission',
  describe: 'the composed mission view — goal · policy · route plans · fingerprint · evidence refs',
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
        note: 'no active mission — no substantive run objective and no live route plan',
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
    if (ref.selectors.child === 'plans') {
      const lines: string[] = []
      for (const plan of view.plans) {
        lines.push(plan.planId + ' r' + plan.revision + ' [' + plan.state + '] ' + plan.profile)
        for (const node of plan.nodes) {
          lines.push(
            '  ' + node.nodeId + ' [' + node.state + ' a' + node.attempt + '] ' + node.title +
              (node.worker ? ' → ' + node.worker : '') +
              (node.model ? ' (' + node.model + ')' : ''),
          )
        }
      }
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://mission/current?child=plans',
          kind: 'mission',
          title: 'mission plans',
          summary: view.plans.length + ' referenced route plan(s)',
          mutable: true,
          text: lines.length > 0 ? lines.join('\n') : '(no route plans — solo mission)',
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
          decisionPoints: view.decisionPoints,
          outcome: view.outcome,
        },
        text: (row?.detail ?? []).join('\n'),
        children: [
          { ref: 'mercury://mission/current?child=plans', title: 'plans', summary: 'route-plan/node references' },
          { ref: 'mercury://mission/current?child=record', title: 'record', summary: 'the full typed MissionView (JSON)' },
        ],
      },
    }
  },
}

// Registered unconditionally; resolve() re-reads the gate LIVE (the
// authority-toggle law) — an OFF flag answers 'unavailable', never a stale
// registration decision.
registerResourceAdapter(missionAdapter)
