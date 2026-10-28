import type { Tool, Tools } from '../../../Tool.js'
import { isDeferredTool, TOOL_SEARCH_TOOL_NAME } from '../../../tools/ToolSearchTool/prompt.js'
import type { Message } from '../../../types/message.js'
import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import { toolToAPISchema } from '../../../utils/api.js'
import { extractDiscoveredToolNames, isToolSearchEnabledOptimistic } from '../../../utils/toolSearch.js'
import { getToolSchemaCache } from '../../../utils/toolSchemaCache.js'
import { zodToJsonSchema } from '../../../utils/zodToJsonSchema.js'
import { inlineLocalSchemaRefs } from '../../../utils/inlineSchemaRefs.js'
import { processOwnerForLane } from '../../run/resolveOwner.js'
import {
  compatChatCallModel,
  compatDispatchModelId,
  compatLaneLiveProofState,
  type CompatCallModelParams,
  type CompatLaneProfile,
} from '../openaicompat/compatChatCallModel.js'
import { buildLocalExtras, localThinkingOff } from '../openaicompat/compatWire.js'
import { getMaxOutputTokensForModel } from '../anthropic/streamCore.js'
import { EFFORT_STAMP_THINKING_OFF, EFFORT_STAMP_THINKING_ON, type EffortWireFact } from '../../../utils/effortStamp.js'
import { planToolPayload, toolsOnTheWire } from '../toolEconomy.js'
import { mapToolsToZai, toolDeclarationRowInResult, type ApiShapedTool } from '../zai/zaiCodec.js'
import { LOCAL_PULL_RECOMMENDATION, resolveLocalApiKey } from './localAccounts.js'
import { configuredProviderKeyCommand, recoverProviderKeyCommand } from '../providerKeyCommand.js'
import { LOCAL_SERVER_NAMES, localContextSourceWords, localFitRefusalSentence, localRecordFor, localWireId } from './localCatalogue.js'
import { confirmServedWindow, ensureServedWindow, getCachedLocalDiscovery, localModelRecord, refreshLocalDiscovery, residentServedWindow, type LocalDiscoveryIo, type LocalModelRecord } from './localDiscovery.js'
import { adoptableLocalWindow, adoptLocalWindow, decideLocalWindow, ensureLocalWindowTruth, heldLocalKnobs, heldLocalWindow, LOCAL_WINDOW_HELD_WORDS, LOCAL_WINDOW_SETTING_WORDS, localPlannedWindow, localWindowApplication, localWindowDecisionLine, localWindowFits, localWindowSettingOf, releaseOutgrownLocalWindow, type HeldLocalWindow } from './localWindow.js'
import { noteLocalTurn } from './localWarm.js'
import { ollamaChatTransport, ollamaChatUrl } from './ollamaChatTransport.js'
import type { CompatCallModelParams as LocalCallParams } from '../openaicompat/compatChatCallModel.js'
import { logForDebugging } from '../../../utils/debug.js'
import { estimateRequestTokens } from '../../tokenEstimation.js'

export function localModelAcceptsEffort(record: LocalModelRecord): boolean {
  if (record.server === 'ollama' || record.server === 'lmstudio') return record.thinkingDeclared === true
  return record.server === 'vllm' || record.server === 'llamacpp'
}

export function localGuardWindow(record: LocalModelRecord, hold?: HeldLocalWindow): { tokens: number; sourceWords: string } | undefined {
  if (hold !== undefined) {
    const application = localWindowApplication(record)
    if ((application === 'request' || application === 'load') && hold.window !== undefined) {
      return { tokens: hold.window, sourceWords: hold.setting === undefined ? LOCAL_WINDOW_HELD_WORDS : LOCAL_WINDOW_SETTING_WORDS }
    }
    const stated = record.contextWindow
    if (stated === undefined || (stated.source !== 'served' && stated.source !== 'modelfile')) return undefined
    return { tokens: stated.tokens, sourceWords: localContextSourceWords(stated.source) }
  }
  const planned = localPlannedWindow(record)
  if (planned === undefined || planned.source === 'model-max') return undefined
  return { tokens: planned.tokens, sourceWords: planned.sourceWords }
}

export function localPromptFitRefusal(model: string, params: LocalEstimateParams): string | undefined {
  const record = localRecordFor(model)
  if (record === undefined) return undefined
  const guard = localGuardWindow(record)
  if (guard === undefined) return undefined
  const toolWire = localToolWireGuess(params.tools, params.messages)
  const fixed = localPreComposeEstimate({ ...params, messages: [], toolWire, model })
  if (fixed <= guard.tokens * LOCAL_FIT_TOLERANCE) return undefined
  const estTokens = localPreComposeEstimate({ ...params, toolWire, model })
  return localFitRefusalSentence({ id: record.id, estTokens, toolCount: toolWire.schemas, window: guard.tokens, sourceWords: guard.sourceWords })
}

export function localPromptFits(model: string, params: LocalEstimateParams): boolean {
  const record = localRecordFor(model)
  if (record === undefined) return false
  const guard = localGuardWindow(record)
  if (guard === undefined) return false
  const toolWire = localToolWireGuess(params.tools, params.messages)
  return localWindowFits(guard.tokens, localPreComposeEstimate({ ...params, toolWire, model }))
}

export const LOCAL_WIRE_BYTES_PER_TOKEN = 3.9
export const LOCAL_FIT_TOLERANCE = 4 / 3
const LOCAL_UNRENDERED_DESCRIPTION_BYTES = 2048

export interface LocalToolWire {
  schemas: number
  schemaBytes: number
  named: number
}

export type LocalEstimateParams = Pick<LocalCallParams, 'messages' | 'systemPrompt' | 'tools'> & { toolWire?: LocalToolWire; model?: string; options?: Pick<LocalCallParams['options'], 'model'> }

function wireBytesOf(apiTools: readonly ApiShapedTool[]): number {
  return apiTools.length === 0 ? 0 : Buffer.byteLength(JSON.stringify(mapToolsToZai(apiTools)), 'utf8')
}

function unrenderedApiTool(tool: Tool): ApiShapedTool {
  const explicit = (tool as { inputJSONSchema?: unknown }).inputJSONSchema
  let input_schema: unknown = {}
  try {
    input_schema = inlineLocalSchemaRefs((explicit as Record<string, unknown> | undefined) ?? zodToJsonSchema(tool.inputSchema as never))
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
  return { schemas: apiTools.length, schemaBytes: wireBytesOf(apiTools), named }
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
  const declared = plan.admissionDeclarations.flatMap(declaration => declaration.tools)
  const schemas = await Promise.all(
    toolsOnTheWire(plan).map(tool =>
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
  const named = [...plan.deferredNames].filter(name => !plan.admittedNames.has(name) && !declared.some(tool => tool.name === name)).length
  return { schemas: plan.roster.length, schemaBytes: wireBytesOf(apiTools), named }
}

export function localPreComposeEstimate(params: LocalEstimateParams): number {
  const tokens = estimateRequestTokens({ messages: params.messages, system: params.systemPrompt }, params.model ?? params.options?.model)
  const wire = params.toolWire ?? localToolWireGuess(params.tools, params.messages)
  return tokens + Math.ceil(wire.schemaBytes / LOCAL_WIRE_BYTES_PER_TOKEN)
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
    recoverCredential: async () => {
      if (!configuredProviderKeyCommand('local')) return null
      const fresh = recoverProviderKeyCommand('local')
      return fresh ? { apiKey: fresh } : undefined
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
    keepsReasoningOnContinuations: () => true,
    toolDeclarationRow: toolDeclarationRowInResult,
    ...(record.server === 'ollama'
      ? {
          streamTransport: (options: Parameters<NonNullable<CompatLaneProfile['streamTransport']>>[0]) => {
            const fit = heldLocalWindow(record)?.fit
            return ollamaChatTransport(
              { ...options, url: ollamaChatUrl(record.baseUrl) },
              {
                ...heldLocalKnobs(record),
                ...(record.thinkingDeclared === true ? { think: !localThinkingOff({ server: record.server, acceptsEffort: localModelAcceptsEffort(record), thinkingEnabled }) } : {}),
                ...(fit !== undefined ? { fit } : {}),
              },
            )
          },
          effortOnWire: ollamaEffortOnWire,
          outputCeiling: (modelId: string) => getMaxOutputTokensForModel(modelId),
        }
      : {}),
    requestFitRefusal: ({ estTokens, toolCount }) => {
      const guard = localGuardWindow(record)
      if (guard === undefined) return undefined
      if (estTokens <= guard.tokens * LOCAL_FIT_TOLERANCE) return undefined
      return localFitRefusalSentence({ id: record.id, estTokens, toolCount, window: guard.tokens, sourceWords: guard.sourceWords })
    },
    servedWindowTokens: () => localGuardWindow(record)?.tokens,
    toolsInPrompt: () => record.toolsDeclared === false,
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

export async function* localCallModel(params: CallModelParams): CallModelStream {
  let record = localRecordFor(params.options.model)
  if (!record) {
    await refreshLocalDiscovery({ force: true }).catch(() => undefined)
    record = localModelRecord(localWireId(params.options.model))
  }
  let confirmAfter = false
  if (record) {
    const application = localWindowApplication(record)
    const io: LocalDiscoveryIo = { signal: params.signal }
    if (application === 'request' || application === 'load') {
      const setting = localWindowSettingOf(record)
      const current = localPreComposeEstimate(params)
      releaseOutgrownLocalWindow(record, current)
      const held = heldLocalWindow(record)
      const estimate = held !== undefined && held.setting === setting ? held.estTokens : localPreComposeEstimate({ ...params, toolWire: await localToolWireOf(params) })
      const decision = decideLocalWindow(record, estimate, setting, await ensureLocalWindowTruth(record, setting))
      logForDebugging(localWindowDecisionLine(record, decision))
      if (application === 'load') {
        await ensureServedWindow(record, io, decision.window !== undefined ? { numCtx: decision.window } : undefined)
      } else {
        confirmAfter = await settleOllamaWindow(record, decision, Math.max(current, estimate), io)
      }
    } else {
      await ensureServedWindow(record, io)
    }
  }
  noteLocalTurn(record)
  yield* compatChatCallModel(record ? localLaneProfileFor(record) : undiscoveredProfile(params.options.model), params)
  if (record && confirmAfter && !params.signal.aborted) await confirmServedWindow(record, { signal: params.signal })
}

export async function settleOllamaWindow(record: LocalModelRecord, decided: HeldLocalWindow, estTokens: number, io: LocalDiscoveryIo): Promise<boolean> {
  let hold = decided
  await ensureServedWindow(record, io, hold.window === undefined ? heldLocalKnobs(record) : { probeOnly: true })
  const resident = residentServedWindow(record)
  if (adoptableLocalWindow(hold, resident, estTokens)) hold = adoptLocalWindow(record, hold, resident)
  return hold.window === undefined || resident !== hold.window
}
