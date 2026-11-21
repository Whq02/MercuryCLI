import { getIsInteractive } from '../bootstrap/state.js'
import { getSystemContext, getUserContext } from '../context.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { logForDebugging } from '../utils/debug.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { isBareMode } from '../utils/envUtils.js'
import { startEventLoopStallDetector } from '../utils/eventLoopStallDetector.js'
import { logError } from '../utils/log.js'
import { getEngineModel } from '../services/model/model.js'
import { settingsChangeDetector } from '../utils/settings/changeDetector.js'
import { skillChangeDetector } from '../utils/skills/skillChangeDetector.js'
import { getTipToShowOnSpinner } from '../services/tips/tipScheduler.js'
import { countFilesRoundedRg } from '../utils/ripgrep.js'
import { checkHasTrustDialogAccepted } from '../utils/config.js'
import { passedOver } from '../utils/passedOver.js'

export function startDeferredPrefetches(): void {
  if (isBareMode()) return
  void import('../services/api/clientContractLearned.js')
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
      const { prefetchThirdPartyCredentials } = (await import('../services/messages/api.js')) as {
        prefetchThirdPartyCredentials?: () => void
      }
      prefetchThirdPartyCredentials?.()
      if (getIsInteractive()) void countFilesRoundedRg(process.cwd(), AbortSignal.timeout(3000)).catch(passedOver)
      const { getModelCapability } = (await import('../utils/model/capabilities.js')) as {
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
