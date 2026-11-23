import type {
  MessageParam,
} from '../../../../engine/message-shapes/wire.js'
import type {
  Message,
} from '../../../../engine/message-shapes/message.js'
import type { Options } from '../../anthropic/streamCore.js'
import {
  assistantMessageToMessageParam,
  userMessageToMessageParam,
} from '../../anthropic/messageParams.js'
import { validateImagesForAPI } from '../../../../engine/requests/imageValidation.js'
import {
  healWalkableForWire,
} from '../../../../engine/messages/messages.js'
import { getSessionId } from '../../../../boot/process-state/processState.js'
import {
  type GptCandidate,
} from '../openaiCatalogue.js'
import {
  decodeOpenaiTurnRecord,
  type BridgeMessage,
  type OpenaiTurnRecord,
} from '../responsesBridge.js'
import { logForDebugging } from '../../../../platform/logs/debugLog.js'
import { stripThinkingFromIndex } from '../../../../engine/messages/apiFilters.js'
import { imagesSupportedForModel } from './images.js'
import type { RequestImageFit } from '../../../../platform/images/imageResizer.js'

function recordAgreesWithContent(record: OpenaiTurnRecord, content: MessageParam['content']): boolean {
  const minted = new Set<string>()
  if (Array.isArray(content)) {
    for (const block of content) {
      if ((block as { type?: string }).type === 'tool_use') minted.add(String((block as { id?: unknown }).id))
    }
  }
  const recorded = new Set<string>()
  for (const item of record.items) {
    if (item.type === 'function_call') recorded.add(item.call_id)
  }
  if (minted.size !== recorded.size) return false
  for (const id of recorded) if (!minted.has(id)) return false
  return true
}

export function toBridgeMessages(
  messages: Message[],
  targetModelId: string,
): { rows: BridgeMessage[]; reconstructedGptTurns: number; foreignRecordsDropped: number; foreignRecordModels: string[] } {
  const out: BridgeMessage[] = []
  const target = targetModelId.trim().toLowerCase()
  let foreignRecordsDropped = 0
  const foreignRecordModels = new Set<string>()
  const gptTurnIds = new Set<string>()
  const recordedTurnIds = new Set<string>()
  const settledTurnIds = new Set<string>()
  for (const m of messages) {
    if (m.type === 'user') {
      const param = userMessageToMessageParam(m, false, false)
      out.push({ role: 'user', content: param.content })
    } else if (m.type === 'assistant') {
      const param = assistantMessageToMessageParam(
        m,
        false,
        false,
      )
      const decoded = decodeOpenaiTurnRecord(m.apexProviderTurn)
      const servedModel = typeof m.message.model === 'string' ? m.message.model : ''
      const sameModel = servedModel.trim().toLowerCase() === target
      const agrees = decoded !== undefined && recordAgreesWithContent(decoded, param.content)
      const record = decoded && sameModel && agrees ? decoded : undefined
      if (decoded && sameModel && !agrees) {
        logForDebugging(
          `[openai] a turn record disagrees with its content on the function calls — the turn replays from its content (${typeof m.message.id === 'string' ? m.message.id : m.uuid})`,
          { level: 'warn' },
        )
      }
      if (decoded && !sameModel) {
        foreignRecordsDropped += 1
        foreignRecordModels.add(servedModel.trim() === '' ? 'an unnamed model' : servedModel.trim())
      }
      const turnKey = typeof m.message.id === 'string' ? m.message.id : m.uuid
      if (servedModel.toLowerCase().startsWith('gpt')) gptTurnIds.add(turnKey)
      if (decoded) recordedTurnIds.add(turnKey)
      if (m.message.stop_reason != null) settledTurnIds.add(turnKey)
      out.push({
        role: 'assistant',
        content: param.content,
        ...(typeof m.message.id === 'string' ? { turnId: m.message.id } : {}),
        ...(record ? { turnRecord: record } : {}),
      })
    }
  }
  let reconstructed = 0
  for (const id of gptTurnIds) {
    if (settledTurnIds.has(id) && !recordedTurnIds.has(id)) reconstructed += 1
  }
  return { rows: out, reconstructedGptTurns: reconstructed, foreignRecordsDropped, foreignRecordModels: [...foreignRecordModels] }
}

const reconstructionNoted = new Set<string>()
const foreignRecordNoted = new Set<string>()

export function bridgeFittedMessages(
  fittedImages: RequestImageFit<Message>,
  options: Options,
  modelId: string,
  candidate: GptCandidate | undefined,
  settlementNotes: string[],
): { imagesRide: boolean; bridge: ReturnType<typeof toBridgeMessages> } {
  const wireMessagesForBridge =
    fittedImages.firstEdited === -1
      ? fittedImages.messages
      : stripThinkingFromIndex(fittedImages.messages, fittedImages.firstEdited)
  const walkable = healWalkableForWire(wireMessagesForBridge)
  const imagesRide = imagesSupportedForModel(candidate)
  if (imagesRide) validateImagesForAPI(walkable, modelId)
  const bridge = toBridgeMessages(walkable, modelId)
  const threadKey = `${getSessionId()}:${options.agentId ?? 'main'}`
  if (bridge.reconstructedGptTurns > 0 && !reconstructionNoted.has(threadKey)) {
    reconstructionNoted.add(threadKey)
    logForDebugging(
      `[openai] reconstructed continuation: ${bridge.reconstructedGptTurns} earlier GPT turn(s) predate reasoning capture — their content replays from the Mercury transcript (benign; new turns record full replay items).`,
      { level: 'info' },
    )
  }
  if (bridge.foreignRecordsDropped > 0 && !foreignRecordNoted.has(threadKey)) {
    foreignRecordNoted.add(threadKey)
    settlementNotes.push(
      `[openai] ${bridge.foreignRecordsDropped} reasoning replay record(s) minted under ${bridge.foreignRecordModels.join(', ')} stay off this ${modelId} request — a replay is bound to the model that minted it; their content replays from the Mercury transcript.`,
    )
  }
  return { imagesRide, bridge }
}
