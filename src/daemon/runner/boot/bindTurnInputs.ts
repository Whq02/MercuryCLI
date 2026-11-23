import type { QueuedCommand } from '../../../screen/composer/input-core/textInput.js'
import { dequeue } from '../messageQueueManager.js'
import { recordTranscript } from '../../../sessions/transcripts/writer.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import type { ContentBlockParam } from '../../../engine/message-shapes/wire.js'
import { parseSlashCommand } from '../../../commands/catalogue/slashCommandParsing.js'
import { findCommand, isCommandEnabled } from '../../../commands/catalogue/commands.js'
import { existsSync } from 'node:fs'
import type { RowDraft } from '../../../engine/rows/project.js'
import * as printTurn from '../runnerTurn.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'isMainThreadCommand' | 'takeMainThread' | 'recordNoticeRows' | 'recordHostNoticeRows' | 'missionLineOf' | 'localCommandInput' | 'executeTurn'> {
  const { getAppState, inputPrompt, live, messages, options } = ports
  const isMainThreadCommand = (command: QueuedCommand): boolean =>
    command.agentId === undefined
  const takeMainThread = (): QueuedCommand | undefined => dequeue(isMainThreadCommand)

  const recordNoticeRows = async (notices: readonly QueuedCommand[], mark: { isVirtual: true } | { isMeta: true }): Promise<void> => {
    const { createUserMessage } = await import('../../../engine/message-shapes/factories.js')
    const rows = notices.map(notice => createUserMessage({ content: notice.value, ...mark, origin: { kind: 'task-notification' }, ...(notice.uuid !== undefined ? { uuid: notice.uuid } : {}), ...(notice.sentAt !== undefined ? { timestamp: notice.sentAt } : {}) }))
    messages.push(...rows)
    await recordTranscript(rows, undefined, messages).catch((error: unknown) => {
      logForDebugging(`host notice: the row was not recorded — ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  const recordHostNoticeRows = (notices: readonly QueuedCommand[]): Promise<void> => recordNoticeRows(notices, { isVirtual: true })
  const missionLineOf = (content: string | ContentBlockParam[], cap: number): string | null => {
    const line = typeof content === 'string' ? content : content.find(block => block.type === 'text')?.text
    const parsed = line === undefined ? null : parseSlashCommand(line)
    if (parsed === null || parsed.isMcp) return null
    const found = findCommand(parsed.commandName, live.activeCommands)
    if (found === undefined || found.name !== 'mission') return null
    const words = parsed.args.trim()
    return words.length > cap ? null : words
  }
  const localCommandInput = (command: QueuedCommand): boolean => {
    if (command.mode === 'bash') return true
    if (command.skipSlashCommands === true || (command.mode !== undefined && command.mode !== 'prompt')) return false
    const value = options.syntaxInput !== undefined && command.value === inputPrompt ? options.syntaxInput : command.value
    const line = typeof value === 'string' ? value : value.find(block => block.type === 'text')?.text
    const parsed = line === undefined ? null : parseSlashCommand(line)
    if (parsed === null) return false
    const found = findCommand(parsed.commandName, [...live.activeCommands, ...getAppState().mcp.commands])
    if (found !== undefined) return found.type !== 'prompt' || !isCommandEnabled(found) || found.userInvocable === false
    return /^[a-zA-Z0-9:_-]+$/.test(parsed.commandName) && !existsSync(`/${parsed.commandName}`)
  }
  const executeTurn = (command: QueuedCommand, batch: QueuedCommand[], onMessage: (message: RowDraft) => void, initialNotices?: QueuedCommand[]): Promise<void> => printTurn.runPrintTurn(command, batch, onMessage, initialNotices, ports)
  return { isMainThreadCommand, takeMainThread, recordNoticeRows, recordHostNoticeRows, missionLineOf, localCommandInput, executeTurn }
}

export const bindTurnInputs: BootStep<'isMainThreadCommand' | 'takeMainThread' | 'recordNoticeRows' | 'recordHostNoticeRows' | 'missionLineOf' | 'localCommandInput' | 'executeTurn'> = { name: 'bindTurnInputs', makes: ['isMainThreadCommand', 'takeMainThread', 'recordNoticeRows', 'recordHostNoticeRows', 'missionLineOf', 'localCommandInput', 'executeTurn'], run }
