import type { RunnerPorts } from './runnerPorts.js'

export type AcceptedInput =
  | { kind: 'prompt'; content: string | ContentBlockParam[]; schema?: Record<string, unknown>; id?: string; priority?: 'now' | 'next' | 'later'; sentAt?: string; origin?: unknown }
  | { kind: 'shell'; command: string; id?: string; priority?: 'now' | 'next' | 'later'; sentAt?: string; origin?: unknown }
  | { kind: 'note'; to: string; content: string; id?: string }
  | { kind: 'outside-report'; sender: string; content: string; id?: string }
export type InputVerdict = { accepted: true } | { accepted: false; reason: 'duplicate' }
import type { QueuedCommand } from '../../types/textInputTypes.js'
import type { ParamsOf } from '../../runner/wire/methods.js'
import type { ContentBlockParam } from '../../types/wire.js'
import { getSessionId } from '../../bootstrap/state.js'
import { doesMessageExistInSession } from '../../utils/sessionStorage.js'
import { type UUID, randomUUID } from 'node:crypto'
import { notifyCommandLifecycle } from '../../utils/commandLifecycle.js'
import { enqueue, remove as removeQueuedCommands } from '../../utils/messageQueueManager.js'
import { operatorPauseGate } from '../../run-core/pauseGate.js'
import { saturnQueueStamp, screenCommandQueueStamp } from '../../utils/messages/noticeRows.js'
import { queuedWordsWaitForTurnEnd, subscribeQueueConsumption } from '../../input-core/command-queue.js'
import { handOverForegroundAgentsToQueuedMessage } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { emptyInputRow, promptSchemaRefusal } from '../structuredIO.js'
import { invalidParams } from '../../runner/wire/errors.js'
import type { InputRow } from '../../rows/vocabulary.js'
import { logForDebugging } from '../../utils/debug.js'
import { type LocalWakeFacts, localWakeStep } from '../../tools/ScheduleWakeupTool/localWake.js'
import { sessionLaneWall } from '../../tools/MonitorTool/laneWall.js'
import { registerLocalWakeSink } from '../../services/saturn/sessionScheduleBridge.js'
import { AGENT_MESSAGE_STATUS } from '../../constants/agentMessage.js'
import { taskRow } from '../../rows/project.js'

export const taskNotificationPayloads = (command: QueuedCommand): string[] => {
  if (command.origin?.kind === 'outside-report') return []
  const texts =
    typeof command.value === 'string'
      ? [command.value]
      : Array.isArray(command.value)
        ? command.value.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
        : []
  if (command.mode !== 'task-notification' && !texts.some(text => text.includes('<task-notification>'))) return []
  return texts.flatMap(text => text.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? [text])
}

const promptContentOf = (content: Extract<ParamsOf<'queue/add'>, { type: 'prompt' }>['content']): string | ContentBlockParam[] => {
  if (typeof content === 'string') return content
  return (content as Array<{ type: string; text?: string; media_type?: string; data?: string }>).map(block =>
    block.type === 'image'
      ? ({ type: 'image', source: { type: 'base64', media_type: block.media_type, data: block.data } } as unknown as ContentBlockParam)
      : ({ type: 'text', text: block.text ?? '' } as ContentBlockParam),
  )
}

export async function acceptInput(input: AcceptedInput, ports: RunnerPorts): Promise<InputVerdict> {
  const { driver, getAppState, live, localCommandInput, missionLineOf, options, receivedUuids, setAppState } = ports
  await options.initializeMcp?.()
  live.sessionInitialized = true
  const missionSync = await import('../../guards/mission.js')
  missionSync.syncMissionFromCard(String(getSessionId()))
  const uuid = input.id
  if (uuid) {
    const historical = await doesMessageExistInSession(
      getSessionId(),
      uuid as UUID,
    ).catch(() => false)
    const runtime = receivedUuids.has(uuid)
    if (historical || runtime) {
      if (historical && !runtime) {
        notifyCommandLifecycle(uuid, 'completed')
      }
      return { accepted: false, reason: 'duplicate' }
    }
    receivedUuids.add(uuid)
  }
  if (input.kind === 'outside-report') {
    enqueue({
      value: input.content,
      mode: 'task-notification',
      origin: { kind: 'outside-report', sender: input.sender, via: 'mcp-server' },
      priority: 'next',
      ridesNextWords: true,
      skipSlashCommands: true,
      ...(uuid !== undefined ? { uuid: uuid as UUID } : {}),
    })
    return { accepted: true }
  }
  if (input.kind === 'note') {
    operatorPauseGate.lift(input.to)
    enqueue({
      value: input.content,
      mode: 'task-notification',
      agentId: input.to as never,
      origin: { kind: 'human' },
      priority: 'next',
      ...(uuid !== undefined ? { uuid: uuid as UUID } : {}),
    })
    return { accepted: true }
  }
  const sentAt = typeof input.sentAt === 'string' && Number.isFinite(Date.parse(input.sentAt)) ? input.sentAt : new Date().toISOString()
  const operatorWords = input.kind === 'prompt' && !('origin' in saturnQueueStamp(input.origin))
  if (operatorWords) operatorPauseGate.resume()
  if (operatorWords && !('origin' in screenCommandQueueStamp(input.origin))) missionSync.resumeMissionOnOperatorInput(String(getSessionId()))
  const missionWords = input.kind === 'prompt' ? missionLineOf(input.content, missionSync.MISSION_CONDITION_MAX_LENGTH) : null
  if (missionWords !== null && missionSync.isMissionClearKeyword(missionWords)) {
    missionSync.clearActiveMission(String(getSessionId()))
    if (uuid !== undefined) notifyCommandLifecycle(uuid, 'completed')
    return { accepted: true }
  }
  const missionSet = missionWords !== null && missionWords !== ''
  const command: QueuedCommand = {
    value: missionSet ? missionSync.setActiveMission(missionWords, { sessionId: String(getSessionId()) }) : input.kind === 'shell' ? input.command : input.content,
    mode: input.kind === 'shell' ? 'bash' : 'prompt',
    sentAt,
    ...(uuid !== undefined ? { uuid: uuid as UUID } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.kind === 'prompt' && input.schema !== undefined ? { schema: input.schema } : {}),
    ...saturnQueueStamp(input.origin),
    ...screenCommandQueueStamp(input.origin),
    ...(missionSet ? { isMeta: true } : {}),
  }
  if (localCommandInput(command)) command.localCommand = true
  enqueue(command)
  if (input.kind === 'prompt' && command.localCommand !== true && input.priority !== 'later' && !('origin' in saturnQueueStamp(input.origin)) && driver.isRunning() && !queuedWordsWaitForTurnEnd()) {
    handOverForegroundAgentsToQueuedMessage(getAppState, setAppState)
  }
  driver.kick()
  return { accepted: true }
}

export async function acceptInputRow(row: InputRow, ports: RunnerPorts): Promise<InputVerdict> {
  const { acceptInput } = ports
  const empty = emptyInputRow(row)
  if (empty !== null) throw invalidParams('queue/add', [{ path: [row.type === 'shell' ? 'command' : 'content'], message: empty }])
  const schemaRefusal = promptSchemaRefusal(row)
  if (schemaRefusal !== null) throw invalidParams('queue/add', [{ path: ['schema'], message: schemaRefusal }])
  if (row.type === 'outside-report') return acceptInput({ kind: 'outside-report', sender: row.sender, content: row.content, ...(row.id !== undefined ? { id: row.id } : {}) })
  if (row.type === 'note') return acceptInput({ kind: 'note', to: row.to, content: row.content, ...(row.id !== undefined ? { id: row.id } : {}) })
  const stamp = {
    ...(row.id !== undefined ? { id: row.id } : {}),
    ...(row.priority !== undefined ? { priority: row.priority } : {}),
    ...(row.sent_at !== undefined ? { sentAt: row.sent_at } : {}),
    ...(row.origin !== undefined ? { origin: row.origin } : {}),
  }
  if (row.type === 'shell') return acceptInput({ kind: 'shell', command: row.command, ...stamp })
  return acceptInput({ kind: 'prompt', content: promptContentOf(row.content), ...(row.schema !== undefined ? { schema: row.schema } : {}), ...stamp })
}

export async function* claimGatedInput(source: AsyncGenerator<InputRow, void, unknown>, ports: RunnerPorts): AsyncGenerator<InputRow, void, unknown> {
  const { live } = ports
  const parked: InputRow[] = []
  for await (const row of source) {
    if (live.awaitingSessionClaim) {
      logForDebugging('[session-runner] an input row arrived before the claim — parked until the session identity lands')
      parked.push(row)
      continue
    }
    yield row
    while (!live.awaitingSessionClaim && parked.length > 0) {
      yield parked.shift()!
    }
  }
}

export function armLocalWake(ports: RunnerPorts): void {
  const { driver, live, streamingInput } = ports
  if (streamingInput) {
    const deliverLocalWake = (prompt: string, facts: LocalWakeFacts | undefined, firedAt: string, heldSince: string | undefined): void => {
      if (live.inputClosed) return
      const nowMs = Date.now()
      const next = localWakeStep(sessionLaneWall(nowMs), nowMs, firedAt, heldSince, facts)
      if (next.step === 'wait') {
        const recheck = setTimeout(() => deliverLocalWake(prompt, facts, firedAt, next.heldSince), next.delayMs)
        recheck.unref?.()
        return
      }
      enqueue({
        value: prompt,
        mode: 'prompt',
        uuid: randomUUID(),
        priority: 'later',
        skipSlashCommands: true,
        ...saturnQueueStamp(next.origin),
      })
      driver.kick()
    }
    registerLocalWakeSink((prompt: string, facts?: LocalWakeFacts) => {
      deliverLocalWake(prompt, facts, new Date().toISOString(), undefined)
    })
  }
}

export function emitTaskNotificationFrames(payloads: readonly string[], ports: RunnerPorts): void {
  const { enqueueRow, liveScope } = ports
  for (const payload of payloads) {
    const pick = (tag: string): string | undefined => {
      const match = payload.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
      return match?.[1]?.trim()
    }
    const statusRaw = pick('status')
    if (statusRaw !== undefined) {
      const normalized =
        statusRaw === AGENT_MESSAGE_STATUS || statusRaw === 'paused'
          ? undefined
          : ['completed', 'failed', 'stopped', 'killed'].includes(statusRaw)
            ? statusRaw === 'killed'
              ? 'stopped'
              : statusRaw
            : 'completed'
      const totalTokens = Number(pick('total-tokens') ?? pick('total_tokens'))
      const toolUses = Number(pick('tool-uses') ?? pick('tool_uses'))
      const callId = pick('tool-use-id')
      enqueueRow(
        taskRow(liveScope(), {
          state: normalized !== undefined ? 'ended' : 'progress',
          taskId: pick('task-id') ?? pick('task_id') ?? '',
          ...(callId !== undefined ? { callId } : {}),
          outputFile: pick('output-file') ?? pick('output_file') ?? '',
          ...(normalized !== undefined ? { status: normalized as 'completed' | 'failed' | 'stopped' } : {}),
          summary: pick('summary') ?? '',
          ...(Number.isFinite(totalTokens) && Number.isFinite(toolUses)
            ? { usage: { tokens: totalTokens, toolUses, durationMs: Number(pick('duration-ms') ?? pick('duration_ms')) || 0 } }
            : {}),
        }),
      )
    }
  }
}

export function emitCommandNotifications(commands: readonly QueuedCommand[], ports: RunnerPorts): void {
  const { announcedNotifications, emitTaskNotificationFrames } = ports
  for (const command of commands) {
    if (announcedNotifications.has(command)) continue
    announcedNotifications.add(command)
    emitTaskNotificationFrames(taskNotificationPayloads(command))
  }
}

export function retireQueuedCommands(commands: QueuedCommand[], ports: RunnerPorts): void {
  const { live } = ports
  live.retiringQueuedCommands = true
  try {
    removeQueuedCommands(commands)
  } finally {
    live.retiringQueuedCommands = false
  }
}

export function watchDrainedNotifications(ports: RunnerPorts): () => void {
  const { emitCommandNotifications, live } = ports
  const stopDrainedNotificationFrames = subscribeQueueConsumption(event => {
    if (event.kind !== 'removed' || live.retiringQueuedCommands) return
    for (const drained of event.commands) {
      if (drained.mode !== 'task-notification' || drained.agentId !== undefined) continue
      emitCommandNotifications([drained])
    }
  })
  return stopDrainedNotificationFrames
}
