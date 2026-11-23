import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import { refreshBoxReading } from '../../../platform/storage/boxLock.js'
import { getCwd } from '../../../platform/files/cwd.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { getSessionId } from '../../../boot/process-state/processState.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

async function run(ports: RunnerPorts): Promise<BootMade<'releaseQueueUntilClaimed' | 'armSessionRunnerWiring'>> {
  const { isConcourseWorker, live, peer, setAppState } = ports
  live.mcpInitialized = !live.awaitingSessionClaim
  const releaseQueueUntilClaimed: (() => void) | null = peer !== null && live.awaitingSessionClaim ? peer.holdScope('queue') : null
  live.runnerRestartReason = flagEnv('MERCURY_RUNNER_RESTART_REASON')
  if (isConcourseWorker) void refreshBoxReading()
  const sessionWiringModules = (): Promise<
    [
      typeof import('../../../permissions/guards/wardsGuard.js'),
      typeof import('../../../crew/crewmates/identity.js'),
    ]
  > =>
    Promise.all([
      import('../../../permissions/guards/wardsGuard.js'),
      import('../../../crew/crewmates/identity.js'),
    ])
  const armSessionRunnerWiring = async (sid: string): Promise<void> => {
    const [wards, crew] = await sessionWiringModules()
    wards.registerWardsGuard(setAppState, sid)
    const mission = await import('../../../permissions/guards/mission.js')
    mission.rearmMissionFromCard({ cardSessionId: sid, armSessionId: sid })
    void crew.bootCrewIdentity({ sessionId: sid, worktreeRef: getCwd() }).catch(e => {
      logForDebugging(`[session-runner] crew identity boot failed (non-blocking): ${e}`)
    })
  }
  if (isConcourseWorker && !live.awaitingSessionClaim) {
    await armSessionRunnerWiring(String(getSessionId()))
  } else if (live.awaitingSessionClaim) {
    void sessionWiringModules().catch(passedOver)
  }
  return { releaseQueueUntilClaimed, armSessionRunnerWiring }
}

export const wireSession: BootStep<'releaseQueueUntilClaimed' | 'armSessionRunnerWiring'> = { name: 'wireSession', makes: ['releaseQueueUntilClaimed', 'armSessionRunnerWiring'], run }
