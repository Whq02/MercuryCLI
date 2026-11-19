import { LOCAL_COMMAND_STDERR_TAG, LOCAL_COMMAND_STDOUT_TAG } from '../../constants/xml.js'
import type { CompactMetadata, Message } from '../../types/message.js'
import type { ContentBlockParam } from '../../types/wire.js'
import { commandOutputRow, commandOutputTextOf, compactionEndedRow, shellOutputTextOf, type RowDraft, type RowScope } from '../project.js'
import type { TurnOptions } from '../turn.js'

function messageTextContent(message: Message): string | null {
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content
  return null
}

function isLocalCommandOutputText(text: string): boolean {
  return text.includes(LOCAL_COMMAND_STDOUT_TAG) || text.includes(LOCAL_COMMAND_STDERR_TAG)
}

export async function* commandOutputRows(inputResult: { messages: Message[] }, priorUuids: Set<string>, scope: RowScope, prompt: string | ContentBlockParam[], options: TurnOptions | undefined): AsyncGenerator<RowDraft, string> {
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
      const meta = (message as { compactMetadata?: CompactMetadata }).compactMetadata
      yield compactionEndedRow(scope, { trigger: meta?.trigger ?? 'manual', tokensBefore: meta?.preTokens })
    }
  }
  return commandAnswer
}
