import { flagEnv } from '../../../substrate/flagRegistry.js'
import { refreshBoxReading } from '../../../utils/boxLock.js'
import { getCwd } from '../../../utils/cwd.js'
import { logForDebugging } from '../../../utils/debug.js'
import { getSessionId } from '../../../bootstrap/state.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

async function run(ports: RunnerPorts): Promise<BootMade<'releaseQueueUntilClaimed' | 'armSessionRunnerWiring'>> {
  const { isConcourseWorker, live, peer, setAppState } = ports
  live.mcpInitialized = !live.awaitingSessionClaim
  const releaseQueueUntilClaimed: (() => void) | null = peer !== null && live.awaitingSessionClaim ? peer.holdScope('queue') : null
  live.runnerRestartReason = flagEnv('MERCURY_RUNNER_RESTART_REASON')
  if (isConcourseWorker) void refreshBoxReading()
  const sessionWiringModules = (): Promise<
    [
      typeof import('../../../guards/wardsGuard.js'),
      typeof import('../../../services/crew/identity.js'),
    ]
  > =>
    Promise.all([
      import('../../../guards/wardsGuard.js'),
      import('../../../services/crew/identity.js'),
    ])
  const armSessionRunnerWiring = async (sid: string): Promise<void> => {
    const [wards, crew] = await sessionWiringModules()
    wards.registerWardsGuard(setAppState, sid)
    const mission = await import('../../../guards/mission.js')
    mission.rearmMissionFromCard({ cardSessionId: sid, armSessionId: sid })
    void crew.bootCrewIdentity({ sessionId: sid, worktreeRef: getCwd() }).catch(e => {
      logForDebugging(`[session-runner] crew identity boot failed (non-blocking): ${e}`)
    })
  }
  if (isConcourseWorker && !live.awaitingSessionClaim) {
    await armSessionRunnerWiring(String(getSessionId()))
  } else if (live.awaitingSessionClaim) {
    void sessionWiringModules().catch(() => {})
  }
  return { releaseQueueUntilClaimed, armSessionRunnerWiring }
}

export const wireSession: BootStep<'releaseQueueUntilClaimed' | 'armSessionRunnerWiring'> = { name: 'wireSession', makes: ['releaseQueueUntilClaimed', 'armSessionRunnerWiring'], run }
