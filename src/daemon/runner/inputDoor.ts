import type { RunnerPorts } from './runnerPorts.js'

export type AcceptedInput =
  | { kind: 'prompt'; content: string | ContentBlockParam[]; schema?: Record<string, unknown>; id?: string; priority?: 'now' | 'next' | 'later'; sentAt?: string; origin?: unknown }
  | { kind: 'shell'; command: string; id?: string; priority?: 'now' | 'next' | 'later'; sentAt?: string; origin?: unknown }
  | { kind: 'note'; to: string; content: string; id?: string }
  | { kind: 'outside-report'; sender: string; content: string; id?: string }
export type InputVerdict = { accepted: true } | { accepted: false; reason: 'duplicate' }
import type { QueuedCommand } from '../../screen/composer/input-core/textInput.js'
import type { ParamsOf } from '../runner-wire/methods.js'
import { SESSION_VERBS } from '../runner-wire/sessionVerbs.js'
import type { Base64ImageSource, ContentBlockParam } from '../../engine/message-shapes/wire.js'
import { getSessionId } from '../../boot/process-state/processState.js'
import { doesMessageExistInSession } from '../../sessions/transcripts/sessionStorage.js'
import { type UUID, randomUUID } from 'node:crypto'
import { notifyCommandLifecycle } from './commandLifecycle.js'
import { enqueue, remove as removeQueuedCommands } from './messageQueueManager.js'
import { operatorPauseGate } from '../../engine/loop/pauseGate.js'
import { saturnQueueStamp, screenCommandQueueStamp } from '../../engine/message-shapes/noticeRows.js'
import { queuedWordsWaitForTurnEnd, subscribeQueueConsumption } from '../../screen/composer/input-core/command-queue.js'
import { handOverForegroundCrewmatesToQueuedMessage } from '../../engine/tasks/local-agent/crewmateTask.js'
import { emptyInputRow, promptSchemaRefusal } from './structuredIO.js'
import { invalidParams } from '../runner-wire/errors.js'
import type { InputRow } from '../../engine/rows/vocabulary.js'
import { type LocalWakeFacts, localWakeStep } from '../../tools/schedule-wakeup/localWake.js'
import { sessionLaneWall } from '../../tools/monitor/laneWall.js'
import { registerLocalWakeSink } from '../saturn/sessionScheduleBridge.js'
import { AGENT_MESSAGE_STATUS } from '../../engine/tasks/local-agent/agentMessage.js'
import { noticeRow, taskRow } from '../../engine/rows/project.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { getTranscriptPath } from '../../sessions/transcripts/paths.js'
import { startTimeout } from '../../platform/async/timers.js'

const duplicateUnreadNotified = new WeakSet<RunnerPorts['live']>()

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

const promptContentOf = (content: Extract<ParamsOf<typeof SESSION_VERBS.sendWords.runner.name>, { type: 'prompt' }>['content']): string | ContentBlockParam[] => {
  if (typeof content === 'string') return content
  return content.map(block =>
    block.type === 'image'
      ? { type: 'image', source: { type: 'base64', media_type: block.media_type as Base64ImageSource['media_type'], data: block.data } }
      : { type: 'text', text: block.text ?? '' },
  )
}

export async function acceptInput(input: AcceptedInput, ports: RunnerPorts): Promise<InputVerdict> {
  const { driver, getAppState, live, localCommandInput, missionLineOf, options, receivedUuids, setAppState } = ports
  await options.initializeMcp?.()
  live.sessionInitialized = true
  const missionSync = await import('../../permissions/guards/mission.js')
  missionSync.syncMissionFromCard(String(getSessionId()))
  const uuid = input.id
  if (uuid) {
    const historical = await doesMessageExistInSession(
      getSessionId(),
      uuid as UUID,
    ).catch((error: unknown) => {
      passedOver(error)
      logForDebugging(`inputDoor: duplicate check failed for ${uuid}: ${errorMessage(error)}`)
      if (!duplicateUnreadNotified.has(live)) {
        duplicateUnreadNotified.add(live)
        if (typeof ports.enqueueRow === 'function' && typeof ports.liveScope === 'function') {
          ports.enqueueRow(
            noticeRow(
              ports.liveScope(),
              'warning',
              `the transcript at ${getTranscriptPath()} could not be read (${errorMessage(error)}), so this message was not checked for a duplicate`,
            ),
          )
        }
      }
      return false
    })
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
      agentId: input.to,
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
    handOverForegroundCrewmatesToQueuedMessage(getAppState, setAppState)
  }
  driver.kick()
  return { accepted: true }
}

export async function acceptInputRow(row: InputRow, ports: RunnerPorts): Promise<InputVerdict> {
  const { acceptInput } = ports
  const empty = emptyInputRow(row)
  if (empty !== null) throw invalidParams(SESSION_VERBS.sendWords.runner.name, [{ path: [row.type === 'shell' ? 'command' : 'content'], message: empty }])
  const schemaRefusal = promptSchemaRefusal(row)
  if (schemaRefusal !== null) throw invalidParams(SESSION_VERBS.sendWords.runner.name, [{ path: ['schema'], message: schemaRefusal }])
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

export function armLocalWake(ports: RunnerPorts): void {
  const { driver, live, streamingInput } = ports
  if (streamingInput) {
    const reportWakeFailure = (error: unknown): void => {
      if (typeof ports.enqueueRow === 'function' && typeof ports.liveScope === 'function') {
        ports.enqueueRow(
          noticeRow(
            ports.liveScope(),
            'warning',
            `a scheduled wake could not be delivered (${errorMessage(error)}) — send it again`,
          ),
        )
      }
    }
    const deliverLocalWake = (prompt: string, facts: LocalWakeFacts | undefined, firedAt: string, heldSince: string | undefined): void => {
      if (live.inputClosed) return
      const nowMs = Date.now()
      const next = localWakeStep(sessionLaneWall(nowMs), nowMs, firedAt, heldSince, facts)
      if (next.step === 'wait') {
        const recheck = startTimeout(() => {
          try {
            deliverLocalWake(prompt, facts, firedAt, next.heldSince)
          } catch (error) {
            passedOver(error)
            reportWakeFailure(error)
          }
        }, next.delayMs)
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
    registerLocalWakeSink(
      (prompt: string, facts?: LocalWakeFacts) => {
        deliverLocalWake(prompt, facts, new Date().toISOString(), undefined)
      },
      error => {
        reportWakeFailure(error)
      },
    )
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
