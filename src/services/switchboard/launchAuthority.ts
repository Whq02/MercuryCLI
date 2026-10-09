import { getSessionId } from '../../bootstrap/state.js'
import { readSessionWorkers, stampedTerminalPid } from '../../daemon/concourseWorkers.js'
import { isProcessAlive } from '../../daemon/ownerWatch.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { BACKGROUND_LAUNCH_LABEL, backgroundSessionsLaunchCrewmates } from './backgroundLaunch.js'
import { spawnSwitch, spawnSwitchOffReceipt, type SpawnSwitchState } from './spawnSwitches.js'

export type LaunchAuthority =
  | { allowed: true; posture: 'attached-or-plain' | 'focused' | 'tagged-background' | 'background-by-setting' }
  | { allowed: false; reason: string; cause: 'session-switch' | 'backgrounded' }

export function backgroundedLaunchRefusal(kind: 'subagents' | 'workflows'): string {
  return `this session is backgrounded — ${kind} wait until the operator visits it, until it holds the workflows-allowed tag (granted by asking the coordinator, choosing keep-and-background on leave, or the manual-start option), or until the operator turns on ${BACKGROUND_LAUNCH_LABEL} (/config, or the boot menu's Agents section). Keep working on the task single-handed.`
}

export function evaluateLaunchAuthority(
  kind: 'subagents' | 'workflows',
  probe?: { dir?: string; sessionId?: string; roleEnvOn?: boolean; spawnSwitch?: SpawnSwitchState; settingOn?: boolean },
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
  if (probe?.settingOn ?? backgroundSessionsLaunchCrewmates()) return { allowed: true, posture: 'background-by-setting' }
  return { allowed: false, reason: backgroundedLaunchRefusal(kind), cause: 'backgrounded' }
}
