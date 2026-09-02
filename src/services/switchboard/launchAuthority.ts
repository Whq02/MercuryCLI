// ============================================================================
//  launchAuthority — the subagent law's mechanical valve.
//
//  The law (operator-ruled; Law 9's shape): the session the operator is IN
//  carries the operator's own seat — a FOCUSED session launches
//  subagents/workflows as the operator's own terminal would, under its own
//  permission mode; background sessions keep working single-handed and
//  wait until visited — unless they hold the ONE workflows-allowed tag.
//
//  Enforcement, not exhortation (the kickoff audit: no gate existed anywhere
//  — background workers could spawn freely, and subagentDoctrine is a prompt
//  layer). The valve RE-READS the durable worker record per call: env stamps
//  freeze at spawn and can never flip on a visit, but the record's facts can
//  — the focus stamp moves with every hop, and a spoken grant lands mid-run.
//  Wired at WorkflowTool.isEnabled / validateInput and AgentTool's call path.
//
//  Process identity: the daemon stamps MERCURY_CONCOURSE_WORKER on every
//  switchboard child — present ⇒ this process is a session runtime and the
//  record decides (focused · tagged · backgrounded); absent ⇒ an interactive
//  process (the operator's own terminal or a plain session), which always
//  may launch.
//
//  The focus fact: the daemon's focus verb stamps focusedAt/focusedBy
//  ('operator:<terminal pid>') on the record the operator hops into and
//  clears the one they left (concourseSupervisor.focusConcourseSession, the
//  fact's one writer). This read trusts a stamp only while its terminal is
//  alive: a terminal that died mid-focus is nobody's seat, whether or not
//  the daemon's reconcile pass has cleared the stamp yet.
// ============================================================================
import { getSessionId } from '../../bootstrap/state.js'
import { readSessionWorkers, stampedTerminalPid } from '../../daemon/concourseSupervisor.js'
import { isProcessAlive } from '../../daemon/ownerWatch.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export type LaunchAuthority =
  | { allowed: true; posture: 'attached-or-plain' | 'focused' | 'tagged-background' }
  | { allowed: false; reason: string }

/**
 * Decide whether THIS process may launch subagents/workflows right now.
 * `probe` exists for provers only — production callers pass nothing.
 */
export function evaluateLaunchAuthority(
  kind: 'subagents' | 'workflows',
  probe?: { dir?: string; sessionId?: string; roleEnvOn?: boolean },
): LaunchAuthority {
  // MERCURY_CONCOURSE_WORKER is a VALUE-kind registry row (the role stamp
  // is '1') — flagEnabled() refuses value flags by contract, so the read
  // is flagEnv === '1' (the composedRoleFromEnv convention).
  const backgroundChild = probe?.roleEnvOn ?? flagEnv('MERCURY_CONCOURSE_WORKER') === '1'
  if (!backgroundChild) return { allowed: true, posture: 'attached-or-plain' }
  const sessionId = probe?.sessionId ?? String(getSessionId())
  try {
    const rec = Object.values(readSessionWorkers(probe?.dir)).find(
      r => r.sessionId === sessionId && r.endedAt === undefined,
    )
    // THE FOCUSED ARM: the chat the operator is inside is the operator's
    // own seat. Read per call and never cached, so a hop flips the answer
    // on the next call — the chat they left is grant-gated again, the one
    // they landed on admits.
    if (rec?.focusedAt !== undefined) {
      const seatPid = stampedTerminalPid(rec.focusedBy)
      if (seatPid !== undefined && isProcessAlive(seatPid)) return { allowed: true, posture: 'focused' }
    }
    if (rec?.workflowsAllowed === true) return { allowed: true, posture: 'tagged-background' }
  } catch {
    // Unreadable records fall through to the refusal — a background child
    // without a provable seat or tag never launches.
  }
  return {
    allowed: false,
    reason: `this session is backgrounded — ${kind} wait until the operator visits it, or until it holds the workflows-allowed tag (granted by asking the coordinator, choosing keep-and-background on leave, or the manual-start option). Keep working on the task single-handed.`,
  }
}
