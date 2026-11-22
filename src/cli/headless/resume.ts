import { existsSync } from 'fs'
import { dirname, join } from 'path'
import {
  isSessionPersistenceDisabled,
  switchSession,
} from 'src/bootstrap/state.js'
import { armProvisionalSessionReconcile } from 'src/utils/provisionalSessionReconcile.js'
import type { AppState } from 'src/state/AppStateStore.js'
import { asSessionId } from 'src/types/ids.js'
import type { Message, NormalizedUserMessage } from 'src/types/message.js'
import { binaryName } from 'src/utils/config.js'
import {
  hasConversationTurn,
  loadConversationForResume,
  type TurnInterruptionState,
} from 'src/services/resume/conversationRecovery.js'
import { gracefulShutdownSync } from 'src/utils/gracefulShutdown.js'
import { logError } from 'src/utils/log.js'
import { restoreSessionStateFromLog } from 'src/services/resume/sessionRestore.js'
import { runSessionStartHooks } from 'src/services/sessionStart.js'
import { consumeSessionHomePin } from 'src/utils/sessionStorage/sessionHomePin.js'
import {
  carrySessionBriefs,
  resetSessionFilePointer,
  restoreSessionMetadata,
} from 'src/utils/sessionStorage.js'
import { parseSessionIdentifier } from 'src/utils/sessionUrl.js'
import { formatPrintsOutcomeRow, refusedOutcome } from './refusalEnvelope.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { ContentReplacementRecord } from '../../utils/toolResultStorage.js'
import { recordContentReplacement, listProjectSessions, sessionIdOfListing } from '../../utils/sessionStorage.js'
import { sessionFilePath } from '../../utils/sessionStorage/loading.js'
import { claimSessionWriter } from '../../utils/sessionStorage/sessionWriter.js'
import { resumeMissMessage } from '../../utils/sessionStorage/resumeMiss.js'
import type { UUID } from 'node:crypto'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export function emitLoadError(
  message: string,
  outputFormat: string | undefined,
): void {
  return notBuilt('src/cli/headless/resume.ts:38')
}

export function removeInterruptedMessage(
  messages: Message[],
  interruptedUserMessage: NormalizedUserMessage,
): void {
  return notBuilt('src/cli/headless/resume.ts:49')
}

type LoadInitialMessagesResult = Unbuilt

export async function loadInitialMessages(
  setAppState: (f: (prev: AppState) => AppState) => void,
  options: {
    continue: boolean | undefined
    resume: string | boolean | undefined
    resumeSessionAt: string | undefined
    forkSession: boolean | undefined
    outputFormat: string | undefined
    sessionStartHooksPromise?: ReturnType<typeof runSessionStartHooks>
  },
): Promise<LoadInitialMessagesResult> {
  return notBuilt('src/cli/headless/resume.ts:72')
}

