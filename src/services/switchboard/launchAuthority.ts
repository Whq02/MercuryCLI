import { getSessionId } from '../../bootstrap/state.js'
import { readSessionWorkers, stampedTerminalPid } from '../../daemon/concourseSupervisor.js'
import { isProcessAlive } from '../../daemon/ownerWatch.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { spawnSwitch, spawnSwitchOffReceipt, type SpawnSwitchState } from './spawnSwitches.js'

export type LaunchAuthority =
  | { allowed: true; posture: 'attached-or-plain' | 'focused' | 'tagged-background' }
  | { allowed: false; reason: string; cause: 'session-switch' | 'backgrounded' }

export function evaluateLaunchAuthority(
  kind: 'subagents' | 'workflows',
  probe?: { dir?: string; sessionId?: string; roleEnvOn?: boolean; spawnSwitch?: SpawnSwitchState },
): LaunchAuthority {
  const sessionSwitch = probe?.spawnSwitch ?? spawnSwitch(kind)
  if (!sessionSwitch.on) return { allowed: false, reason: spawnSwitchOffReceipt(kind), cause: 'session-switch' }
  const backgroundChild = probe?.roleEnvOn ?? flagEnv('MERCURY_CONCOURSE_WORKER') === '1'
  if (!backgroundChild) return { allowed: true, posture: 'attached-or-plain' }
  const sessionId = probe?.sessionId ?? String(getSessionId())
  try {
    const rec = Object.values(readSessionWorkers(probe?.dir)).find(
      r => r.sessionId === sessionId && r.endedAt === undefined,
    )
    if (rec?.focusedAt !== undefined) {
      const seatPid = stampedTerminalPid(rec.focusedBy)
      if (seatPid !== undefined && isProcessAlive(seatPid)) return { allowed: true, posture: 'focused' }
    }
    if (rec?.workflowsAllowed === true) return { allowed: true, posture: 'tagged-background' }
  } catch {
  }
  return {
    allowed: false,
    reason: `this session is backgrounded — ${kind} wait until the operator visits it, or until it holds the workflows-allowed tag (granted by asking the coordinator, choosing keep-and-background on leave, or the manual-start option). Keep working on the task single-handed.`,
    cause: 'backgrounded',
  }
}
