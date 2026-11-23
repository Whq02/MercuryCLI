import { createSeatReceiptMessage } from '../../../engine/message-shapes/systemMessages.js'
import { isSessionPersistenceDisabled, getSessionId } from '../../../boot/process-state/processState.js'
import { hasConversationTurn } from '../../../sessions/resume/conversationRecovery.js'
import { getSessionMessages, adoptResumedSessionFile, recordTranscript, peekProject } from '../../../sessions/transcripts/writer.js'
import type { UUID } from 'node:crypto'
import { isChainParticipant } from '../../../sessions/transcripts/paths.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { toError } from '../../../platform/errors/errors.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

async function run(ports: RunnerPorts): Promise<BootMade<'persistBootModelRefusal'>> {
  const { live, messages, options } = ports
  const persistBootModelRefusal = async (refusal: string): Promise<void> => {
    const refusalRow = createSeatReceiptMessage(refusal, 'warning')
    const persist = !isSessionPersistenceDisabled() && hasConversationTurn(messages)
    const onDisk = persist ? await getSessionMessages(getSessionId() as UUID) : null
    const leaf = onDisk === null ? undefined : messages.findLast(m => isChainParticipant(m) && onDisk.has(m.uuid as UUID))
    messages.push(refusalRow)
    if (persist) {
      adoptResumedSessionFile()
      void recordTranscript([refusalRow], leaf?.uuid as UUID | undefined, messages)
        .then(() => peekProject()?.flush())
        .catch((error: unknown) => logError(toError(error)))
    }
  }
  if (options.title && !live.awaitingSessionClaim && !isSessionPersistenceDisabled()) {
    const { saveCustomTitle } = await import('../../../sessions/transcripts/sessionListings.js')
    await saveCustomTitle(getSessionId() as UUID, options.title)
  }
  if (live.bootModelRefusal !== null) live.bootRefusalFact = live.bootModelRefusal
  if (live.bootModelRefusal !== null && !live.awaitingSessionClaim) await persistBootModelRefusal(live.bootModelRefusal)
  return { persistBootModelRefusal }
}

export const recordBootRefusal: BootStep<'persistBootModelRefusal'> = { name: 'recordBootRefusal', makes: ['persistBootModelRefusal'], run }
