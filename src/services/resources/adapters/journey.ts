// ============================================================================
//  resources/adapters/journey — mercury://journey/*.
//  Feature-owned kind, registered from the journeys slice:
//    mercury://journey            — recorded journeys this conversation
//    mercury://journey/<id>      — one journey (steps · evidence · cleanup)
// ============================================================================

import { journeysEnabled } from '../../journeys/contracts.js'
import { getJourney, journeyExpired, listJourneys } from '../../journeys/runner.js'
import { registerResourceAdapter } from '../registry.js'
import type { ResourceAdapter } from '../contracts.js'

export const journeyAdapter: ResourceAdapter = {
  kind: 'journey',
  describe: 'local application-verification journeys (steps · evidence · cleanup · verdict)',
  async resolve(ref, ctx) {
    if (!journeysEnabled()) {
      return { state: 'unavailable', note: 'journeys are disabled (MERCURY_JOURNEYS=0)' }
    }
    if (!ref.id) {
      const all = listJourneys(ctx.owner)
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://journey',
          kind: 'journey',
          title: 'journeys',
          summary: `${all.length} recorded this conversation`,
          mutable: true,
          children: all.map(j => ({
            ref: `mercury://journey/${j.id}`,
            title: j.id,
            summary: `[${j.state}] ${j.objective.slice(0, 60)} — ${j.steps.filter(s => s.state === 'passed').length}/${j.steps.length} passed`,
          })),
        },
      }
    }
    const j = getJourney(ctx.owner, ref.id)
    if (!j) {
      if (journeyExpired(ctx.owner, ref.id)) {
        return { state: 'expired', note: `journey '${ref.id}' fell off the bounded ring (16 kept)` }
      }
      return { state: 'absent', note: `no journey '${ref.id}' in this conversation` }
    }
    return {
      state: 'ok',
      resource: {
        ref: `mercury://journey/${j.id}`,
        kind: 'journey',
        title: `${j.id} [${j.state}]`,
        summary: `${j.objective.slice(0, 80)} — ${j.steps.filter(s => s.state === 'passed').length}/${j.steps.length} step(s) passed`,
        mutable: j.state === 'running',
        structured: {
          objective: j.objective,
          state: j.state,
          ...(j.failedStep !== undefined && { failedStep: j.failedStep }),
          steps: j.steps.map(s => ({
            index: s.index,
            kind: s.kind,
            label: s.label,
            state: s.state,
            detail: s.detail,
            elapsedMs: s.elapsedMs,
            ...(s.evidenceRef !== undefined && { evidenceRef: s.evidenceRef }),
          })),
          cleanup: j.cleanup,
          executionRef: j.executionRef,
          evidenceRefs: j.evidenceRefs,
        },
      },
    }
  },
  async list(ctx) {
    return listJourneys(ctx.owner).map(j => ({
      ref: `mercury://journey/${j.id}`,
      title: j.id,
      summary: `[${j.state}] ${j.objective.slice(0, 60)}`,
    }))
  },
}

registerResourceAdapter(journeyAdapter)
