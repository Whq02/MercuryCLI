// resources/adapters/run — the owner's durable run + its effect/check
// timeline (mercury://run/current). The SAME snapshot the stop evaluator
// reads — never a re-derivation.

import { getRunSnapshot } from '../../run/runCoordinator.js'
import type {
  ParsedRef,
  ResourceAdapter,
  ResourceContext,
  ResourceResult,
} from '../contracts.js'

export const runAdapter: ResourceAdapter = {
  kind: 'run',
  describe: "the conversation's durable run + effect timeline (mercury://run/current)",
  async resolve(ref: ParsedRef, ctx: ResourceContext): Promise<ResourceResult> {
    if (ref.id !== '' && ref.id !== 'current') {
      return {
        state: 'absent',
        note: "run refs address the owner's live run: mercury://run/current",
      }
    }
    const snapshot = getRunSnapshot(ctx.owner)
    if (!snapshot) {
      return { state: 'absent', note: 'no substantive run is active for this conversation' }
    }
    const deliverables = snapshot.deliverables
    const effects = snapshot.recentEffects as Array<{
      operation?: string
      outcome?: string
      changedPaths?: string[]
    }>
    const lines: string[] = [
      `lifecycle: ${snapshot.lifecycle} · phase: ${snapshot.phase}`,
      `objective: ${snapshot.objective || '(none recorded)'}`,
      `verification: ${snapshot.verification.state} — ${snapshot.verification.detail}`,
      `ide feedback: ${snapshot.ideFeedback.state} — ${snapshot.ideFeedback.detail}`,
      ...(snapshot.blocker ? [`blocker: ${JSON.stringify(snapshot.blocker)}`] : []),
      '',
      `deliverables (${deliverables.length}):`,
      ...deliverables.map(
        d =>
          `  ${(d as { state?: string }).state ?? '?'} — ${(d as { subject?: string }).subject ?? '?'}`,
      ),
      '',
      `recent effects (${effects.length} of ${snapshot.totalEvents} events):`,
      ...effects.map(
        e =>
          `  ${e.outcome ?? '?'} ${e.operation ?? '?'}${e.changedPaths?.length ? ` → ${e.changedPaths.join(', ')}` : ''}`,
      ),
    ]
    return {
      state: 'ok',
      resource: {
        ref: ref.canonical || 'mercury://run/current',
        kind: 'run',
        title: `run ${snapshot.runId} (${snapshot.lifecycle})`,
        summary: `${deliverables.length} deliverable(s) · ${effects.length} recent effect(s) · ${snapshot.totalChangedPaths} changed path(s) · verification ${snapshot.verification.state}`,
        version: `e${snapshot.totalEvents}`,
        mutable: false,
        text: lines.join('\n'),
        structured: {
          lifecycle: snapshot.lifecycle,
          deliverables: deliverables.length,
          changedPaths: snapshot.changedPaths.slice(0, 50),
          verification: snapshot.verification.state,
        },
      },
    }
  },
}
