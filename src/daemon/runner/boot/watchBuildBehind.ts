import { runningBuildTree, describeArtifactIdentity } from '../../../platform/product/artifactIdentity.js'
import { composeBuildBehindLine } from '../../../tools/monitor/watchReceipts.js'
import { dirname } from 'node:path'
import { getTranscriptPath } from '../../../sessions/transcripts/paths.js'
import { getSessionId } from '../../../boot/process-state/processState.js'
import { readSessionReceipts, appendSessionReceipt } from '../../switchboard/sessionReceipts.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { createSeatReceiptMessage } from '../../../engine/message-shapes/systemMessages.js'
import { recordTranscript, peekProject } from '../../../sessions/transcripts/writer.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { startInterval, startTimeout } from '../../../platform/async/timers.js'

const BUILD_BEHIND_FLOOR_MS = 60_000

const BUILD_BEHIND_THROTTLE_MS = 2_000

const BUILD_BEHIND_CONFIRM_MS = 2_000

function run(ports: RunnerPorts): BootMade<'checkBuildBehind' | 'buildBehindFloor'> {
  const { isConcourseWorker, live, messages } = ports
  const buildBehindToldFor = new Set<string>()
  const checkBuildBehind = async (now = false): Promise<void> => {
    if (!isConcourseWorker || live.awaitingSessionClaim || live.inputClosed || live.inFlightAbort !== null) return
    if (!now && Date.now() - live.buildBehindCheckedAt < BUILD_BEHIND_THROTTLE_MS) return
    live.buildBehindCheckedAt = Date.now()
    const ownTree = runningBuildTree()
    if (ownTree === null) return
    const { deployedRuntime } = await import('../../control/handover.js')
    const installed = deployedRuntime()
    const installedTree = installed?.buildTree ?? null
    if (installed === null || installedTree === null || installedTree === ownTree || buildBehindToldFor.has(installedTree)) {
      live.buildBehindSeen = null
      return
    }
    if (live.buildBehindSeen !== installedTree) {
      live.buildBehindSeen = installedTree
      if (live.buildBehindConfirm === null) {
        live.buildBehindConfirm = startTimeout(() => {
          live.buildBehindConfirm = null
          void checkBuildBehind(true)
        }, BUILD_BEHIND_CONFIRM_MS)
        live.buildBehindConfirm.unref?.()
      }
      return
    }
    if (live.inFlightAbort !== null || live.inputClosed) return
    buildBehindToldFor.add(installedTree)
    const ownTime = describeArtifactIdentity('', process.argv[1] ?? null).buildTime
    const installedTime = describeArtifactIdentity('', installed.script).buildTime
    const line = composeBuildBehindLine(installedTree, ownTree, ownTime === null || installedTime === null || installedTime > ownTime)
    const home = dirname(getTranscriptPath())
    const sid = String(getSessionId())
    try {
      if (readSessionReceipts(home, sid).some(r => r.kind === 'build-behind' && (r.details?.installedTree === installedTree || r.summary === line))) return
      appendSessionReceipt(home, sid, {
        at: new Date().toISOString(),
        by: 'runner',
        kind: 'build-behind',
        summary: line,
        details: { installedTree, runningTree: ownTree },
      })
    } catch (error) {
      logError(error)
    }
    const row = createSeatReceiptMessage(line, 'warning')
    messages.push(row)
    void recordTranscript([row], undefined, messages)
      .then(() => peekProject()?.flush())
      .catch(passedOver)
  }
  const buildBehindFloor = isConcourseWorker ? startInterval(() => void checkBuildBehind(true), BUILD_BEHIND_FLOOR_MS) : null
  buildBehindFloor?.unref?.()
  return { checkBuildBehind, buildBehindFloor }
}

export const watchBuildBehind: BootStep<'checkBuildBehind' | 'buildBehindFloor'> = { name: 'watchBuildBehind', makes: ['checkBuildBehind', 'buildBehindFloor'], run }
