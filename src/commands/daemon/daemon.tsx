import { DaemonView } from '../../screen/widgets/parity/DaemonView.js'
import { LOCAL_COMMAND_STDOUT_TAG } from '../../engine/message-shapes/messageTags.js'
import { getFocusedSessionConnector } from '../../engine/connector/focusedConnector.js'
import { haltAll, summarizeHalt } from '../../daemon/control/haltAll.js'
import { createCommandInputMessage, createUserMessage } from '../../engine/messages/messages.js'
import { formatCommandLoadingMetadata } from '../../engine/user-input/processSlashCommand.js'
import type { LocalCommandResult, LocalJSXCommandCall } from '../catalogue/command.js'
import type { ToolUseContext } from '../../tools/kit/tool.js'

async function haltVerb(context: ToolUseContext): Promise<LocalCommandResult> {
  const focused = getFocusedSessionConnector()
  if (focused.turnActive()) focused.interrupt()
  const result = await haltAll(context as Parameters<typeof haltAll>[0])
  return { type: 'text', value: `⊘ Hard stop — ${summarizeHalt(result)}.` }
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const verb = args.trim().split(/\s+/)[0]
  if (verb === 'halt') {
    const receipt = await haltVerb(context as ToolUseContext)
    const words = receipt.type === 'text' ? receipt.value : ''
    const chat = getFocusedSessionConnector()
    if (chat.addDisplayRow === undefined) {
      onDone(words, { display: 'system' })
      return null
    }
    chat.addDisplayRow(createUserMessage({ content: formatCommandLoadingMetadata('daemon', args.trim()) }))
    chat.addDisplayRow(createCommandInputMessage(`<${LOCAL_COMMAND_STDOUT_TAG}>${words}</${LOCAL_COMMAND_STDOUT_TAG}>`))
    onDone(undefined, { display: 'skip' })
    return null
  }
  if (verb === 'restart') {
    const { restartDaemon } = await import('../../daemon/control/handshake.js')
    const { getCwd } = await import('../../platform/files/cwd.js')
    const receipt = await restartDaemon({ by: 'operator', posture: 'owned', dir: getCwd() })
    onDone(receipt.line, { display: 'system' })
    return null
  }
  return <DaemonView onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }} />
}
