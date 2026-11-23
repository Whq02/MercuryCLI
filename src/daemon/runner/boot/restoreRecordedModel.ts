import { getEngineModelOverride, setEngineModelOverride } from '../../../boot/process-state/processState.js'
import { restoreConversationModel } from '../../../sessions/resume/sessionRestore.js'
import { resolveHeadlessModel, bootModelRefusalLine } from '../model.js'
import { parseUserSpecifiedModel, getEngineModel } from '../../../models/catalogue/engineModel.js'
import { errorMessage } from '../../../platform/errors/errors.js'
import { emitLoadError } from '../resume.js'
import { gracefulShutdownSync } from '../../../platform/processes/gracefulShutdown.js'
import { noticeRow } from '../../../engine/rows/project.js'
import { BOOT_ENDS, type BootMade, type BootStep, type RunnerPorts } from '../runnerPorts.js'

async function run(ports: RunnerPorts): Promise<BootMade<never>> {
  const { enqueueRow, live, liveScope, loaded, messages, options, wire } = ports
  if ((options.continue || options.resume) && !getEngineModelOverride()) {
    const recorded = restoreConversationModel({ messages, model: loaded.model })
    if (recorded && !options.userSpecifiedModel) {
      try {
        live.bootModel = await resolveHeadlessModel(recorded)
        setEngineModelOverride(live.bootModel)
      } catch (error) {
        if (recorded.toLowerCase().startsWith('compat/')) {
          if (wire) {
            live.bootModel = parseUserSpecifiedModel(recorded)
            setEngineModelOverride(live.bootModel)
            live.bootModelRefusal = bootModelRefusalLine(live.bootModel, errorMessage(error))
          } else {
            emitLoadError(`The resumed session's model '${recorded}' is not usable: ${errorMessage(error)}`, options.outputFormat)
            gracefulShutdownSync(1)
            return BOOT_ENDS
          }
        } else {
          enqueueRow(noticeRow(liveScope(), 'warning', `The resumed session's model '${recorded}' is not usable (${errorMessage(error)}) — this run uses ${getEngineModel()} instead.`))
        }
      }
    }
  }
  return {}
}

export const restoreRecordedModel: BootStep<never> = { name: 'restoreRecordedModel', makes: [], run }
