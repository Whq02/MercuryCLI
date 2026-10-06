import * as React from 'react'
import { DaemonView } from '../../components/mercury-ui/parity/DaemonView.js'
import { LOCAL_COMMAND_STDOUT_TAG } from '../../constants/xml.js'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import { haltAll, summarizeHalt } from '../../utils/haltAll.js'
import { createCommandInputMessage, createUserMessage } from '../../utils/messages.js'
import { formatCommandLoadingMetadata } from '../../utils/processUserInput/processSlashCommand.js'
import type { LocalCommandResult, LocalJSXCommandCall } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'

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
    const chat = getFocusedSessionConnector() as { addDisplayRow?: (row: Message) => void }
    if (typeof chat.addDisplayRow !== 'function') {
      onDone(words, { display: 'system' })
      return null
    }
    chat.addDisplayRow(createUserMessage({ content: formatCommandLoadingMetadata('daemon', args.trim()) }))
    chat.addDisplayRow(createCommandInputMessage(`<${LOCAL_COMMAND_STDOUT_TAG}>${words}</${LOCAL_COMMAND_STDOUT_TAG}>`))
    onDone(undefined, { display: 'skip' })
    return null
  }
  if (verb === 'restart') {
    const { restartDaemon } = await import('../../daemon/handshake.js')
    const { getCwd } = await import('../../utils/cwd.js')
    const receipt = await restartDaemon({ by: 'operator', posture: 'owned', dir: getCwd() })
    onDone(receipt.line, { display: 'system' })
    return null
  }
  return <DaemonView onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }} />
}
