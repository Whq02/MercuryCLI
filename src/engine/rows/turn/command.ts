import { LOCAL_COMMAND_STDERR_TAG, LOCAL_COMMAND_STDOUT_TAG } from '../../message-shapes/messageTags.js'
import type { FoldMetadata, Message } from '../../message-shapes/message.js'
import type { ContentBlockParam } from '../../message-shapes/wire.js'
import { turnCutOf } from '../../message-shapes/turnCut.js'
import type { processUserInput } from '../../user-input/processUserInput.js'
import { flushSessionStorage } from '../../../sessions/transcripts/sessionStorage.js'
import { commandOutputRow, commandOutputTextOf, shellOutputTextOf, compactionEndedRow, type RowDraft, type RowScope } from '../project.js'
import { statusOfTerminal, OUTCOME_SENTENCES } from '../vocabulary.js'
import type { TurnOptions } from '../turn.js'
import type { ConversationState } from './state.js'
import type { turnEnder } from './end.js'

function messageTextContent(message: Message): string | null {
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content
  return null
}

function isLocalCommandOutputText(text: string): boolean {
  return text.includes(LOCAL_COMMAND_STDOUT_TAG) || text.includes(LOCAL_COMMAND_STDERR_TAG)
}

interface CommandNeeds {
  inputResult: Awaited<ReturnType<typeof processUserInput>>
  priorUuids: Set<string>
  options: TurnOptions | undefined
  scope: RowScope
  prompt: string | ContentBlockParam[]
  persistenceDisabled: boolean
  turnMessages: Message[]
  eagerFlush: boolean
  endTurn: ReturnType<typeof turnEnder>
}

export async function* commandTurnRows(this: ConversationState, needs: CommandNeeds): AsyncGenerator<RowDraft> {
  const { inputResult, priorUuids, options, scope, prompt, persistenceDisabled, turnMessages, eagerFlush, endTurn } = needs
  let commandAnswer = ''
  for (const message of inputResult.messages) {
    if (priorUuids.has(message.uuid)) continue
    if (message.type === 'user') {
      const text = messageTextContent(message)
      const isCompactSummary = (message as { isCompactSummary?: boolean }).isCompactSummary === true
      const shellOutput = text !== null && options?.mode === 'bash' ? shellOutputTextOf(text) : null
      if (shellOutput !== null) {
        commandAnswer = shellOutput
        yield commandOutputRow(scope, shellOutput, typeof prompt === 'string' ? prompt : undefined)
      } else if (text !== null && isLocalCommandOutputText(text) && !isCompactSummary) {
        yield commandOutputRow(scope, commandOutputTextOf(text), typeof prompt === 'string' ? prompt.split(/\s+/)[0] : undefined)
      }
    } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'local_command') {
      const content = (message as { content?: unknown }).content
      if (typeof content === 'string' && isLocalCommandOutputText(content)) {
        yield commandOutputRow(scope, commandOutputTextOf(content), typeof prompt === 'string' ? prompt.split(/\s+/)[0] : undefined)
      }
    } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
      const meta = (message as { compactMetadata?: FoldMetadata }).compactMetadata
      yield compactionEndedRow(scope, { trigger: meta?.trigger ?? 'manual', tokensBefore: meta?.preTokens })
    }
  }
  if (!persistenceDisabled) {
    await this.recordDelta(turnMessages)
    if (eagerFlush) await flushSessionStorage()
  }
  if (options?.mode === 'bash' && this.abortController.signal.aborted) {
    const cut = turnCutOf(this.abortController.signal.reason)
    const ended = statusOfTerminal({ reason: 'aborted_tools' }, cut.kind)
    yield* endTurn(ended.status, { error: { message: ended.status === 'interrupted' ? OUTCOME_SENTENCES.interrupted({}) : cut.kind === 'idle-timeout' ? 'The turn was aborted after a no-progress timeout' : `The turn was cut: ${cut.detail ?? 'the run was aborted'}`, class: ended.errorClass ?? 'interrupt' } })
    return
  }
  if (inputResult.commandError !== undefined) {
    yield* endTurn('failed', { error: { message: inputResult.commandError, class: 'command' } })
    return
  }
  const refused = inputResult.commandRefused === true || inputResult.hookBlocked === true
  yield* endTurn(refused ? 'refused' : 'completed', {
    ...(refused
      ? { error: { message: inputResult.resultText ?? 'The request was refused', class: inputResult.hookBlocked === true ? 'hook' : 'command' } }
      : { answer: inputResult.resultText ?? commandAnswer }),
  })
  return
}
