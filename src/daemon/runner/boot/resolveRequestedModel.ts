import { resolveHeadlessModel, bootModelRefusalLine } from '../model.js'
import { setEngineModelOverride } from '../../../boot/process-state/processState.js'
import { errorMessage } from '../../../platform/errors/errors.js'
import { formatPrintsOutcomeRow, refusedOutcome } from '../refusalEnvelope.js'
import { jsonStringify } from '../../../platform/logs/slowOperations.js'
import { gracefulShutdownSync } from '../../../platform/processes/gracefulShutdown.js'
import { parseUserSpecifiedModel } from '../../../models/catalogue/engineModel.js'
import { BOOT_ENDS, type BootMade, type BootStep, type RunnerPorts } from '../runnerPorts.js'

async function run(ports: RunnerPorts): Promise<BootMade<never>> {
  const { live, options } = ports
  if (options.userSpecifiedModel !== undefined) {
    try {
      live.bootModel = await resolveHeadlessModel(options.userSpecifiedModel)
      setEngineModelOverride(live.bootModel)
    } catch (error) {
      const message = errorMessage(error)
      if (options.door !== 'wire') {
        if (formatPrintsOutcomeRow(options.outputFormat)) process.stdout.write(jsonStringify(refusedOutcome([message])) + '\n')
        else process.stderr.write(`${message}\n`)
        gracefulShutdownSync(1)
        return BOOT_ENDS
      }
      live.bootModel = parseUserSpecifiedModel(options.userSpecifiedModel)
      setEngineModelOverride(live.bootModel)
      live.bootModelRefusal = bootModelRefusalLine(live.bootModel, message)
    }
  }
  return {}
}

export const resolveRequestedModel: BootStep<never> = { name: 'resolveRequestedModel', makes: [], run }
