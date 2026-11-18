import { flagEnv } from '../../../substrate/flagRegistry.js'
import { isSessionPersistenceDisabled, getSessionId } from '../../../bootstrap/state.js'
import { claimSessionWriter } from '../../../utils/sessionStorage/sessionWriter.js'
import { sessionFilePath } from '../../../utils/sessionStorage/loading.js'
import type { UUID } from 'node:crypto'
import { emitLoadError } from '../resume.js'
import { errorMessage } from '../../../utils/errors.js'
import { gracefulShutdownSync } from '../../../utils/gracefulShutdown.js'
import { BOOT_ENDS, type BootMade, type BootStep, type RunnerPorts } from '../runnerPorts.js'

async function run(ports: RunnerPorts): Promise<BootMade<'isConcourseWorker'>> {
  const { live, options } = ports
  const isConcourseWorker = flagEnv('MERCURY_CONCOURSE_WORKER') === '1'
  live.awaitingSessionClaim = isConcourseWorker && !options.continue && !options.resume && options.bootSessionIdPinned !== true
  if (!live.awaitingSessionClaim && (!options.continue && !options.resume || options.forkSession) && !isSessionPersistenceDisabled()) {
    try { await claimSessionWriter(sessionFilePath(getSessionId() as UUID)) }
    catch (error) {
      emitLoadError(errorMessage(error), options.outputFormat)
      gracefulShutdownSync(1)
      return BOOT_ENDS
    }
  }
  return { isConcourseWorker }
}

export const takeSessionWriter: BootStep<'isConcourseWorker'> = { name: 'takeSessionWriter', makes: ['isConcourseWorker'], run }
