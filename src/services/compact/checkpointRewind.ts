import type { Message, UserMessage } from '../../types/message.js'
import { createUserMessage } from '../../utils/messages/factories.js'

export const CHECKPOINT_TOOL_NAME = 'Checkpoint'
export const REWIND_TOOL_NAME = 'Rewind'

export const REWIND_RECORD_TAG = 'mercury-rewind-record'

export interface ActiveCheckpoint {
  id: string
  goal: string
  boundaryIndex: number
  messageCountAtCreation: number
}

type Blockish = { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean }

function blocksOf(message: Message): Blockish[] {
  const content = (message as { message?: { content?: unknown } }).message?.content
  return Array.isArray(content) ? (content as Blockish[]) : []
}

function textOf(message: Message): string {
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: string }>)
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('\n')
}

function rewindRecordIndexes(messages: readonly Message[]): Map<string, number> {
  const out = new Map<string, number>()
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if ((m as { type?: string }).type !== 'user') continue
    const text = textOf(m)
    if (!text.startsWith(`<${REWIND_RECORD_TAG}`)) continue
    const match = text.match(/checkpoint="([^"]+)"/)
    if (match?.[1]) out.set(match[1], i)
  }
  return out
}

export function findActiveCheckpoint(messages: readonly Message[]): ActiveCheckpoint | null {
  const records = rewindRecordIndexes(messages)
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if ((m as { type?: string }).type !== 'assistant') continue
    for (const block of blocksOf(m)) {
      if (block.type !== 'tool_use' || block.name !== CHECKPOINT_TOOL_NAME || !block.id) continue
      if (records.has(block.id)) return null
      for (let j = i + 1; j < messages.length; j++) {
        const candidate = messages[j]!
        if ((candidate as { type?: string }).type !== 'user') continue
        const result = blocksOf(candidate).find(
          b => b.type === 'tool_result' && b.tool_use_id === block.id,
        )
        if (result === undefined) continue
        if (result.is_error === true) return null
        const goal = (block.input as { goal?: unknown } | undefined)?.goal
        return {
          id: block.id,
          goal: typeof goal === 'string' ? goal : '',
          boundaryIndex: j,
          messageCountAtCreation: j + 1,
        }
      }
      return null
    }
  }
  return null
}

export function createRewindRecordMessage(args: {
  checkpointId: string
  goal: string
  report: string
  abandonedMessageCount: number
  rootFallback: boolean
}): UserMessage {
  const { checkpointId, goal, report, abandonedMessageCount, rootFallback } = args
  const lines = [
    `<${REWIND_RECORD_TAG} checkpoint="${checkpointId}"${rootFallback ? ' fallback="root"' : ''}>`,
    `The conversation was rewound to the checkpoint${goal ? ` (goal: ${goal})` : ''}.`,
    `${abandonedMessageCount} message(s) of abandoned exploration were removed from the model context (the operator's transcript keeps them).`,
    'Report carried back from the exploration:',
    report,
    `</${REWIND_RECORD_TAG}>`,
  ]
  return createUserMessage({ content: lines.join('\n'), isMeta: true })
}


export function createOperatorRewindRecordMessage(args: { turnUuid: string; removed: number }): UserMessage {
  const lines = [
    `<${REWIND_RECORD_TAG} turn="${args.turnUuid}" by="operator">`,
    `The operator wound the conversation back to before this turn; ${args.removed} message(s) left the model's view (the transcript keeps them).`,
    `</${REWIND_RECORD_TAG}>`,
  ]
  return createUserMessage({ content: lines.join('\n'), isMeta: true })
}

function operatorRewindRecordIndexes(messages: readonly Message[]): Map<string, number> {
  const out = new Map<string, number>()
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if ((m as { type?: string }).type !== 'user') continue
    const text = textOf(m)
    if (!text.startsWith(`<${REWIND_RECORD_TAG}`)) continue
    const match = text.match(/\bturn="([^"]+)"/)
    if (match?.[1]) out.set(match[1], i)
  }
  return out
}

function operatorRewindExclusions(messages: readonly Message[], excluded: Set<number>): void {
  const records = operatorRewindRecordIndexes(messages)
  if (records.size === 0) return
  for (const [turnUuid, recordIndex] of records) {
    const turnIndex = messages.findIndex(m => (m as { uuid?: string }).uuid === turnUuid)
    if (turnIndex === -1 || turnIndex > recordIndex) {
      excluded.add(recordIndex)
      continue
    }
    for (let i = turnIndex; i <= recordIndex; i++) excluded.add(i)
  }
}

export function projectOperatorRewinds<T extends Message>(messages: T[]): T[] {
  const excluded = new Set<number>()
  operatorRewindExclusions(messages, excluded)
  if (excluded.size === 0) return messages
  return messages.filter((_, i) => !excluded.has(i))
}

export function projectRewoundWindows<T extends Message>(messages: T[]): T[] {
  const excluded = new Set<number>()
  agentRewindExclusions(messages, excluded)
  operatorRewindExclusions(messages, excluded)
  if (excluded.size === 0) return messages
  return messages.filter((_, i) => !excluded.has(i))
}

function agentRewindExclusions(messages: readonly Message[], excluded: Set<number>): void {
  const records = rewindRecordIndexes(messages)
  if (records.size === 0) return

  const boundaries = new Map<string, number>()
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if ((m as { type?: string }).type !== 'assistant') continue
    for (const block of blocksOf(m)) {
      if (block.type !== 'tool_use' || block.name !== CHECKPOINT_TOOL_NAME || !block.id) continue
      if (!records.has(block.id)) continue
      for (let j = i + 1; j < messages.length; j++) {
        const candidate = messages[j]!
        if ((candidate as { type?: string }).type !== 'user') continue
        if (blocksOf(candidate).some(b => b.type === 'tool_result' && b.tool_use_id === block.id)) {
          boundaries.set(block.id, j)
          break
        }
      }
    }
  }

  for (const [checkpointId, recordIndex] of records) {
    const boundary = boundaries.get(checkpointId)
    if (boundary !== undefined && boundary < recordIndex) {
      for (let i = boundary + 1; i < recordIndex; i++) excluded.add(i)
    } else {
      const record = messages[recordIndex]!
      const isRootFallback = textOf(record).includes('fallback="root"')
      if (isRootFallback) {
        for (let i = 0; i < recordIndex; i++) excluded.add(i)
      }
    }
  }
}

export function buildRewindRecordIfSettled(
  roundMessages: readonly Message[],
  toolUseBlocks: ReadonlyArray<{ name?: string; id?: string; input?: unknown }>,
  toolResults: readonly Message[],
): UserMessage | null {
  const rewindUse = toolUseBlocks.find(b => b.name === REWIND_TOOL_NAME && b.id)
  if (rewindUse === undefined) return null
  const settled = toolResults.some(m =>
    blocksOf(m).some(
      b => b.type === 'tool_result' && b.tool_use_id === rewindUse.id && b.is_error !== true,
    ),
  )
  if (!settled) return null
  const report = (rewindUse.input as { report?: unknown } | undefined)?.report
  const checkpoint = findActiveCheckpoint(roundMessages)
  if (checkpoint === null) {
    return null
  }
  const abandoned = Math.max(0, roundMessages.length - (checkpoint.boundaryIndex + 1))
  return createRewindRecordMessage({
    checkpointId: checkpoint.id,
    goal: checkpoint.goal,
    report: typeof report === 'string' ? report.trim() : '',
    abandonedMessageCount: abandoned,
    rootFallback: false,
  })
}

export function createSettleGuardWarning(checkpoint: ActiveCheckpoint): UserMessage {
  return createUserMessage({
    content:
      `<system-warning>A checkpoint is still active${checkpoint.goal ? ` (goal: ${checkpoint.goal})` : ''} and no Rewind has been issued. ` +
      `Call Rewind { report } to restore the pre-exploration context and carry your findings back, ` +
      `or state explicitly why the exploration should stand.</system-warning>`,
    isMeta: true,
  })
}
