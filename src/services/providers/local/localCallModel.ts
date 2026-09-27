import type { Tool, Tools } from '../../../Tool.js'
import { isDeferredTool, TOOL_SEARCH_TOOL_NAME } from '../../../tools/ToolSearchTool/prompt.js'
import type { AssistantMessage, Message, StreamEvent, SystemAPIErrorMessage } from '../../../types/message.js'
import { toolToAPISchema } from '../../../utils/api.js'
import { extractDiscoveredToolNames, isDeferredToolsDeltaEnabled, isToolSearchEnabledOptimistic } from '../../../utils/toolSearch.js'
import { getToolSchemaCache } from '../../../utils/toolSchemaCache.js'
import { zodToJsonSchema } from '../../../utils/zodToJsonSchema.js'
import { processOwnerForLane } from '../../run/resolveOwner.js'
import {
  compatChatCallModel,
  compatDispatchModelId,
  compatLaneLiveProofState,
  type CompatCallModelParams,
  type CompatLaneProfile,
} from '../openaicompat/compatChatCallModel.js'
import { buildLocalExtras, localThinkingOff } from '../openaicompat/compatWire.js'
import { EFFORT_STAMP_THINKING_OFF, EFFORT_STAMP_THINKING_ON, type EffortWireFact } from '../../../utils/effortStamp.js'
import { deferredToolsAnnouncement, planToolPayload } from '../toolEconomy.js'
import { mapToolsToZai, type ApiShapedTool } from '../zai/zaiCodec.js'
import { LOCAL_PULL_RECOMMENDATION, resolveLocalApiKey } from './localAccounts.js'
import { LOCAL_SERVER_NAMES, localContextSourceWords, localFitRefusalSentence, localRecordFor, localWireId } from './localCatalogue.js'
import { confirmServedWindow, ensureServedWindow, getCachedLocalDiscovery, localModelRecord, refreshLocalDiscovery, servedWindowIsCurrent, type LocalModelRecord } from './localDiscovery.js'
import { chooseLocalBatch, decideLocalWindow, ensureLocalWindowTruth, heldLocalWindow, localBatchSettingOf, localWindowApplication, localWindowDecisionLine, localWindowSettingOf, type HeldLocalWindow } from './localWindow.js'
import { noteLocalTurn } from './localWarm.js'
import { ollamaChatTransport, ollamaChatUrl } from './ollamaChatTransport.js'
import type { CompatCallModelParams as LocalCallParams } from '../openaicompat/compatChatCallModel.js'
import { logForDebugging } from '../../../utils/debug.js'

export function localModelAcceptsEffort(record: LocalModelRecord): boolean {
  if (record.server === 'ollama' || record.server === 'lmstudio') return record.thinkingDeclared === true
  return record.server === 'vllm' || record.server === 'llamacpp'
}

export function localGuardWindow(record: LocalModelRecord, hold: HeldLocalWindow | undefined = heldLocalWindow(record)): { tokens: number; sourceWords: string } | undefined {
  const application = localWindowApplication(record)
  const applies = application === 'request' || application === 'load'
  if (applies && hold !== undefined && hold.window !== undefined) {
    return {
      tokens: hold.window,
      sourceWords: hold.setting === undefined ? 'chosen by Mercury for this session (auto) — /config → Local model window' : 'your setting — /config → Local model window',
    }
  }
  const stated = record.contextWindow
  if (stated === undefined || (stated.source !== 'served' && stated.source !== 'modelfile')) return undefined
  return { tokens: stated.tokens, sourceWords: localContextSourceWords(stated.source) }
}

export const LOCAL_WIRE_BYTES_PER_TOKEN = 3.9
export const LOCAL_FIT_TOLERANCE = 4 / 3
const LOCAL_UNRENDERED_DESCRIPTION_BYTES = 2048

export interface LocalToolWire {
  schemas: number
  schemaBytes: number
  named: number
  nameRowBytes: number
}

export type LocalEstimateParams = Pick<LocalCallParams, 'messages' | 'systemPrompt' | 'tools'> & { toolWire?: LocalToolWire }

function wireBytesOf(apiTools: readonly ApiShapedTool[]): number {
  return apiTools.length === 0 ? 0 : Buffer.byteLength(JSON.stringify(mapToolsToZai(apiTools)), 'utf8')
}

function unrenderedApiTool(tool: Tool): ApiShapedTool {
  const explicit = (tool as { inputJSONSchema?: unknown }).inputJSONSchema
  let input_schema: unknown = {}
  try {
    input_schema = explicit ?? zodToJsonSchema(tool.inputSchema as never)
  } catch {
    input_schema = {}
  }
  return { name: tool.name, description: ' '.repeat(LOCAL_UNRENDERED_DESCRIPTION_BYTES), input_schema }
}

export function localToolWireGuess(tools: Tools, messages: readonly Message[]): LocalToolWire {
  const deferred = new Set(tools.filter(tool => isDeferredTool(tool)).map(tool => tool.name))
  const deferring = isToolSearchEnabledOptimistic() && tools.some(tool => tool.name === TOOL_SEARCH_TOOL_NAME) && deferred.size > 0
  const admitted = deferring ? extractDiscoveredToolNames(messages as Message[]) : new Set<string>()
  const roster = deferring ? tools.filter(tool => !deferred.has(tool.name) || admitted.has(tool.name)) : tools.filter(tool => tool.name !== TOOL_SEARCH_TOOL_NAME)
  const rendered = new Map<string, ApiShapedTool>()
  for (const built of getToolSchemaCache().values()) rendered.set(built.name, { name: built.name, ...(built.description ? { description: built.description } : {}), input_schema: built.input_schema })
  const apiTools = roster.map(tool => rendered.get(tool.name) ?? unrenderedApiTool(tool))
  const named = deferring ? [...deferred].filter(name => !admitted.has(name)).length : 0
  const nameRow = deferring && !isDeferredToolsDeltaEnabled() ? deferredToolsAnnouncement(tools, deferred) : null
  return { schemas: apiTools.length, schemaBytes: wireBytesOf(apiTools), named, nameRowBytes: nameRow === null ? 0 : Buffer.byteLength(nameRow, 'utf8') }
}

export async function localToolWireOf(params: CompatCallModelParams): Promise<LocalToolWire> {
  const { options } = params
  const model = compatDispatchModelId(options.model)
  const plan = await planToolPayload({
    model,
    tools: params.tools,
    messages: params.messages,
    getToolPermissionContext: options.getToolPermissionContext,
    agents: options.agents,
    latchKey: options.ownerKey ?? String(processOwnerForLane(options.agentId ?? null)),
    hasPendingMcpServers: options.hasPendingMcpServers,
    source: 'estimate',
  })
  const schemas = await Promise.all(
    plan.roster.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext: options.getToolPermissionContext,
        tools: plan.roster,
        agents: options.agents,
        allowedAgentTypes: options.allowedAgentTypes,
        model,
        conversationKey: plan.conversationKey,
      }),
    ),
  )
  const apiTools: ApiShapedTool[] = []
  for (const schema of schemas) {
    const shaped = schema as { name?: string; description?: string; input_schema?: unknown }
    if (typeof shaped.name === 'string' && shaped.input_schema !== undefined) {
      apiTools.push({ name: shaped.name, ...(shaped.description ? { description: shaped.description } : {}), input_schema: shaped.input_schema })
    }
  }
  const named = [...plan.deferredNames].filter(name => !plan.admittedNames.has(name)).length
  return { schemas: apiTools.length, schemaBytes: wireBytesOf(apiTools), named, nameRowBytes: plan.announcement === null ? 0 : Buffer.byteLength(plan.announcement, 'utf8') }
}

export function localPreComposeEstimate(params: LocalEstimateParams): number {
  let bytes = 0
  try {
    bytes += Buffer.byteLength(JSON.stringify(params.messages), 'utf8') + Buffer.byteLength(JSON.stringify(params.systemPrompt), 'utf8')
  } catch {
    bytes += 0
  }
  const wire = params.toolWire ?? localToolWireGuess(params.tools, params.messages)
  return Math.ceil(bytes / 4) + Math.ceil((wire.schemaBytes + wire.nameRowBytes) / LOCAL_WIRE_BYTES_PER_TOKEN)
}

export function localLaneProfileFor(record: LocalModelRecord): CompatLaneProfile {
  let thinkingEnabled = false
  const ollamaEffortOnWire = (): EffortWireFact => {
    if (record.thinkingDeclared !== true) return { kind: 'unsupported' }
    const off = localThinkingOff({ server: record.server, acceptsEffort: localModelAcceptsEffort(record), thinkingEnabled })
    return { kind: 'sent', parameter: 'think', value: !off, applied: off ? EFFORT_STAMP_THINKING_OFF : EFFORT_STAMP_THINKING_ON }
  }
  return {
    lane: 'local',
    providerLabel: LOCAL_SERVER_NAMES[record.server],
    resolveCredential: () => {
      const key = resolveLocalApiKey()
      return key ? { apiKey: key.key } : {}
    },
    credentialHint: 'the local server is not reachable.',
    authRemedy:
      'the server rejected the request credential — set MERCURY_LOCAL_API_KEY to the key the server was started with (its --api-key), or start it keyless.',
    requestUrl: () => `${record.baseUrl}/chat/completions`,
    wireModelId: () => record.id,
    buildExtras: args => {
      thinkingEnabled = args.thinkingEnabled
      return buildLocalExtras({ ...args, server: record.server, acceptsEffort: localModelAcceptsEffort(record) })
    },
    omitsToolChoice: record.server === 'ollama',
    ...(record.server === 'ollama'
      ? {
          streamTransport: (options: Parameters<NonNullable<CompatLaneProfile['streamTransport']>>[0]) =>
            ollamaChatTransport(
              { ...options, url: ollamaChatUrl(record.baseUrl) },
              {
                ...(heldLocalWindow(record)?.window !== undefined ? { numCtx: heldLocalWindow(record)!.window } : {}),
                numBatch: chooseLocalBatch(localBatchSettingOf(record), heldLocalWindow(record)?.window),
                ...(record.thinkingDeclared === true ? { think: !localThinkingOff({ server: record.server, acceptsEffort: localModelAcceptsEffort(record), thinkingEnabled }) } : {}),
              },
            ),
          effortOnWire: ollamaEffortOnWire,
        }
      : {}),
    requestFitRefusal: ({ requestBytes, estTokens: estimated, toolCount }) => {
      const guard = localGuardWindow(record)
      if (guard === undefined) return undefined
      const bytes = Number.isFinite(requestBytes) ? requestBytes : estimated * 4
      const estTokens = Math.ceil(bytes / LOCAL_WIRE_BYTES_PER_TOKEN)
      if (estTokens <= guard.tokens * LOCAL_FIT_TOLERANCE) return undefined
      return localFitRefusalSentence({ id: record.id, estTokens, toolCount, window: guard.tokens, sourceWords: guard.sourceWords })
    },
    toolCapabilityRefusal: () => {
      if (record.toolsDeclared === false) {
        return `${LOCAL_SERVER_NAMES[record.server]} lists '${record.id}' without tool support — this model cannot take a tool-bearing turn; pick a tool-capable local model (Ollama: capabilities include 'tools'; LM Studio: trained for tool use) for roles that carry tools.`
      }
      return undefined
    },
  }
}

export function undiscoveredLocalHint(modelId: string): string {
  const wire = localWireId(modelId)
  const ollama = getCachedLocalDiscovery()?.servers.find(server => server.kind === 'ollama')
  if (ollama) {
    return `no local server lists this model — ${ollama.label} answers but has not pulled '${wire}': ollama pull ${wire} (or ${LOCAL_PULL_RECOMMENDATION}); /model lists what is pulled and re-probes on open.`
  }
  return `no local server lists this model — start Ollama (:11434), LM Studio (:1234), vLLM (:8000) or llama.cpp-server (:8080), or point MERCURY_LOCAL_BASE_URL at your server, then ${LOCAL_PULL_RECOMMENDATION}; /model re-probes on open.`
}

function undiscoveredProfile(modelId: string): CompatLaneProfile {
  return {
    lane: 'local',
    providerLabel: 'Local models',
    resolveCredential: () => undefined,
    credentialHint: undiscoveredLocalHint(modelId),
    requestUrl: () => {
      throw new Error('undiscovered local model — resolveCredential refuses before this point')
    },
    wireModelId: id => localWireId(id),
    buildExtras: () => ({}),
  }
}

export function localLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('local')
}

export async function* localCallModel(
  params: CompatCallModelParams,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  let record = localRecordFor(params.options.model)
  if (!record) {
    await refreshLocalDiscovery({ force: true }).catch(() => undefined)
    record = localModelRecord(localWireId(params.options.model))
  }
  let confirmAfter = false
  if (record) {
    const application = localWindowApplication(record)
    if (application === 'request' || application === 'load') {
      const setting = localWindowSettingOf(record)
      const held = heldLocalWindow(record)
      const estimate = held !== undefined && held.setting === setting ? held.estTokens : localPreComposeEstimate({ ...params, toolWire: await localToolWireOf(params) })
      const decision = decideLocalWindow(record, estimate, setting, await ensureLocalWindowTruth(record, setting))
      logForDebugging(localWindowDecisionLine(record, decision))
      if (application === 'load') {
        await ensureServedWindow(record, { signal: params.signal }, decision.window !== undefined ? { numCtx: decision.window } : undefined)
      } else if (decision.window === undefined) {
        await ensureServedWindow(record, { signal: params.signal })
      } else {
        confirmAfter = !(servedWindowIsCurrent(record) && record.contextWindow?.tokens === decision.window)
      }
    } else {
      await ensureServedWindow(record, { signal: params.signal })
    }
  }
  noteLocalTurn(record)
  yield* compatChatCallModel(record ? localLaneProfileFor(record) : undiscoveredProfile(params.options.model), params)
  if (record && confirmAfter && !params.signal.aborted) await confirmServedWindow(record, { signal: params.signal })
}
