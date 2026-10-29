import type { AssistantMessage, ReplyMark } from '../types/message.js'
import { NO_CONTENT_MESSAGE } from '../constants/messages.js'

type DrainableCommand = {
  uuid?: string
  mode?: string
  agentId?: string
  value?: unknown
}

type DrainedRow = {
  timestamp: string
  attachment: { type?: string; source_uuid?: string; commandMode?: string; origin?: { kind: string }; isMeta?: boolean }
}

export function replyMarkOf(row: DrainedRow): ReplyMark | null {
  const att = row.attachment
  if (att.type !== 'queued_command' || typeof att.source_uuid !== 'string' || att.source_uuid === '') return null
  if (att.isMeta === true || att.commandMode === 'task-notification') return null
  if (att.origin !== undefined && att.origin.kind !== 'human') return null
  return { uuid: att.source_uuid, at: row.timestamp }
}

export function isReplyText(message: Pick<AssistantMessage, 'isApiErrorMessage' | 'message'>): boolean {
  if (message.isApiErrorMessage === true) return false
  return message.message.content.some(block => block.type === 'text' && block.text.trim() !== '' && block.text !== NO_CONTENT_MESSAGE)
}

export function stampReply<M extends Pick<AssistantMessage, 'isApiErrorMessage' | 'message' | 'inReplyTo'>>(message: M, awaiting: ReplyMark[]): M {
  if (awaiting.length === 0 || message.isApiErrorMessage === true) return message
  const marks = awaiting.splice(0)
  if (isReplyText(message)) message.inReplyTo = marks
  return message
}

export type DrainScope = {

  sleepRan: boolean
  isMainThread: boolean
  agentId: string | undefined
}

export function selectDrainableCommands<C extends DrainableCommand>(
  commands: C[],
  scope: DrainScope,
  isSlashCommand: (cmd: C) => boolean,
): C[] {
  const ownsTheQueue = scope.isMainThread && scope.agentId === undefined
  return commands.filter(cmd => {
    if (isSlashCommand(cmd)) return false
    if (ownsTheQueue) return cmd.agentId === undefined
    return cmd.mode === 'task-notification' && cmd.agentId === scope.agentId
  })
}

export function consumeDrainedCommands<C extends DrainableCommand>(
  snapshot: C[],
  effects: {
    notifyStarted: (uuid: string) => void
    removeFromQueue: (commands: C[]) => void
  },
): string[] {
  const consumed = snapshot.filter(
    cmd => cmd.mode === 'prompt' || cmd.mode === 'task-notification',
  )
  const uuids: string[] = []
  if (consumed.length > 0) {
    for (const cmd of consumed) {
      if (cmd.uuid) {
        uuids.push(cmd.uuid)
        effects.notifyStarted(cmd.uuid)
      }
    }
    effects.removeFromQueue(consumed)
  }
  return uuids
}
