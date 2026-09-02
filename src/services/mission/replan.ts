// ============================================================================
// services/mission/replan — the bounded replan-trigger vocabulary (H4).
//
//  Replanning EXECUTES through the route-fabric owner (routerRunStore.reviseNode
//  — per-node NODE_MAX_ATTEMPTS + the plan-wide MISSION_REPLAN_CEILING both
//  refuse at the store). This module owns only the TYPED TRIGGER vocabulary:
//  a revision is justified by an OBSERVED event class, named by the planner
//  on the revise and recorded in the revision note + event echo. Free-form
//  churn ("try again") classifies to null and is refused when a trigger is
//  required.
// ============================================================================

export const MISSION_REPLAN_TRIGGERS = [
  'check-failed', //             a required check failed with new diagnostic evidence
  'undeclared-dependency', //    a node discovered a shared owner / missing dep
  'combination-unavailable', //  the selected model/tool combination is unavailable
  'symbol-moved', //             an expected file or symbol moved
  'incomplete-envelope', //      a worker returned incomplete/indeterminate
  'restart-reconstruction', //   a restart reconstructed unfinished valid nodes
  'reviewer-unmet-acceptance', //the reviewer named a specific unmet condition
  'size-reassessed', //          the task proved smaller/larger than fingerprinted
] as const
export type MissionReplanTrigger = (typeof MISSION_REPLAN_TRIGGERS)[number]

export function isMissionReplanTrigger(v: unknown): v is MissionReplanTrigger {
  return typeof v === 'string' && (MISSION_REPLAN_TRIGGERS as readonly string[]).includes(v)
}

/** Best-effort classification of a legacy free-text revision note into the
 *  typed vocabulary (projection use only — the op seam takes the typed field). */
export function classifyReplanNote(note: string): MissionReplanTrigger | null {
  const text = note.toLowerCase()
  if (/\btrigger:\s*([a-z-]+)/.test(text)) {
    const tagged = /\btrigger:\s*([a-z-]+)/.exec(text)?.[1]
    if (isMissionReplanTrigger(tagged)) return tagged
  }
  if (/(check|test|suite).{0,24}(fail|red)/.test(text)) return 'check-failed'
  if (/(shared owner|undeclared|conflict|same file)/.test(text)) return 'undeclared-dependency'
  if (/(unavailable|unqualified|no such model|tool missing)/.test(text)) return 'combination-unavailable'
  if (/(moved|renamed|no longer exists|not found)/.test(text)) return 'symbol-moved'
  if (/(incomplete|indeterminate|generation retired|no result)/.test(text)) return 'incomplete-envelope'
  if (/(restart|reconstruct|resume)/.test(text)) return 'restart-reconstruction'
  if (/(review|acceptance).{0,24}(unmet|missing|failed)/.test(text)) return 'reviewer-unmet-acceptance'
  if (/(smaller|larger|scope (grew|shrank)|split further)/.test(text)) return 'size-reassessed'
  return null
}
