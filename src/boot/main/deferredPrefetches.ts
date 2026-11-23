import { getIsInteractive } from '../process-state/processState.js'
import { getSystemContext, getUserContext } from '../../engine/requestContext.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { logForDiagnosticsNoPII } from '../../platform/logs/diagnosticsLog.js'
import { isBareMode } from '../../platform/environment/envUtils.js'
import { startEventLoopStallDetector } from './eventLoopStallDetector.js'
import { logError } from '../../platform/logs/errorLog.js'
import { getEngineModel } from '../../models/catalogue/engineModel.js'
import { settingsChangeDetector } from '../../platform/settings/changeDetector.js'
import { skillChangeDetector } from '../../integrations/skill-watch/skillChangeDetector.js'
import { getTipToShowOnSpinner } from '../../screen/tips/tipScheduler.js'
import { countFilesRoundedRg } from '../../platform/shell/ripgrep.js'
import { checkHasTrustDialogAccepted } from '../../platform/settings/config.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export function startDeferredPrefetches(): void {
  if (isBareMode()) return
  void import('../../engine/requests/clientContractLearned.js')
    .then(({ startClientContractPeek }) => startClientContractPeek())
    .catch((error: unknown) => logForDebugging(`client contract: the daily peek did not start: ${String(error)}`))
  void (async () => {
    try {
      void getUserContext().catch(passedOver)
      if (!getIsInteractive()) {
        logForDiagnosticsNoPII('info', 'prefetch_system_context_non_interactive')
        void getSystemContext().catch(passedOver)
      } else if (checkHasTrustDialogAccepted()) {
        logForDiagnosticsNoPII('info', 'prefetch_system_context_has_trust')
        void getSystemContext().catch(passedOver)
      } else {
        logForDiagnosticsNoPII('info', 'prefetch_system_context_skipped_no_trust')
      }
      void getTipToShowOnSpinner().catch(passedOver)
      const { prefetchThirdPartyCredentials } = (await import('../../engine/messages/apiSystemAndToolSchema.js')) as {
        prefetchThirdPartyCredentials?: () => void
      }
      prefetchThirdPartyCredentials?.()
      if (getIsInteractive()) void countFilesRoundedRg(process.cwd(), AbortSignal.timeout(3000)).catch(passedOver)
      const { getModelCapability } = (await import('../../models/facts/capabilities.js')) as {
        getModelCapability?: (model: string) => unknown
      }
      getModelCapability?.(getEngineModel())
      settingsChangeDetector.initialize()
      skillChangeDetector.initialize()
    } catch (error) {
      logError(error)
    }
  })()
  if (flagEnv('MERCURY_STALL_DETECTOR') !== '0') {
    startEventLoopStallDetector()
  }
}
