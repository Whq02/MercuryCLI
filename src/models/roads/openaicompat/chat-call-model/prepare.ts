import { processOwnerForLane } from '../../../../engine/run-owner/resolveOwner.js'
import { createHash } from 'crypto'
import { compatToolSchemaRefusal } from '../compatToolSchemas.js'
import { getCwd } from '../../../../platform/files/cwd.js'
import { mintCacheDomainKey } from '../../../../platform/cache-clock/cacheDomain.js'
import type {
  MessageParam,
} from '../../../../engine/message-shapes/wire.js'
import type { Tools } from '../../../../tools/kit/tool.js'
import type {
  AssistantMessage,
  Message,
} from '../../../../engine/message-shapes/message.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../../../engine/requests/apiErrorRows.js'
import { estimateRequestTokens } from '../../streamIdleBudget.js'
import { fitOutputTokensForRequest, outputFitWords } from '../../../../engine/requests/outputFit.js'
import {
  recordPromptState,
  type CacheLane,
} from '../../../../engine/requests/promptCacheBreakDetection.js'
import type { Options } from '../../anthropic/streamCore.js'
import {
  assistantMessageToMessageParam,
  userMessageToMessageParam,
} from '../../anthropic/messageParams.js'
import { toolToAPISchema } from '../../../../engine/messages/apiSystemAndToolSchema.js'
import {
  healWalkableForWire,
} from '../../../../engine/messages/messages.js'
import { resolveEffortTruth, resolveWireRequestedEffort, type EffortValue } from '../../../effort/effort.js'
import { floorEffort } from '../../../catalogue/utilityModel.js'
import { effortStampOf, type EffortStampV1 } from '../../../effort/effortStamp.js'
import { compatEffortWireFact } from '../compatWire.js'
import { operatorModelFacts } from '../../../catalogue/modelOverrides.js'
import { logForDebugging } from '../../../../platform/logs/debugLog.js'
import {
  renderGenericInstructions,
  resolveBehaviourContract,
  stableBehaviourDigest,
} from '../../../../engine/system-prompt/behaviourContract.js'
import { mapMessagesToZai, mapToolsToZai, toolDeclarationRowAsText, type ApiShapedTool, type ToolDeclarationRowBuilder } from '../../zai/zaiCodec.js'
import type { ZaiWireMessage } from '../../zai/zaiClient.js'
import { effortVocabularyFor, getModelMaxOutputTokens, modelSupportsPDF } from '../../../facts/capabilities.js'
import { compatImageRefusalWords } from '../compatProbe.js'
import {
  type CompatChatRequest,
  type CompatDeferralFacts,
} from '../compatChatClient.js'
import { renderToolDialectHistory, toolDialectSystemText } from '../../local/toolDialect.js'
import { planToolPayload, renderAdmissionRecordsAsText, type ToolPayloadPlan } from '../../toolEconomy.js'
import { retireOlderScreenshots } from '../../../../integrations/desktop/screenshotRetention.js'
import { fitImagesToRequestCap, type RequestImageFit } from '../../../../platform/images/imageResizer.js'
import { stripThinkingFromIndex } from '../../../../engine/messages/apiFilters.js'
import { withToolReferenceTurnBoundary } from '../../../../engine/messages/apiView.js'
import { fitToolResultImages } from '../../../../engine/message-shapes/imageRequestFit.js'
import { imagesSupportedForCompatModel, laneExtrasWithOperatorEffort, type CompatCallModelParams, type CompatCredential, type CompatLaneProfile } from './lane.js'
import { apiErrorMessage } from './faults.js'

export function toBridgeMessages(
  messages: Message[],
): MessageParam[] {
  const out: MessageParam[] = []
  for (const m of messages) {
    if (m.type === 'user') {
      out.push(userMessageToMessageParam(m, false, false))
    } else if (m.type === 'assistant') {
      out.push(assistantMessageToMessageParam(m, false, false))
    }
  }
  return out
}

async function buildApiShapedTools(
  tools: Tools,
  options: Options,
  model: string,
  conversationKey?: string,
  pool: Tools = tools,
): Promise<ApiShapedTool[]> {
  const schemas = await Promise.all(
    tools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext: options.getToolPermissionContext,
        tools: pool,
        agents: options.agents,
        allowedAgentTypes: options.allowedAgentTypes,
        model,
        conversationKey,
      }),
    ),
  )
  const out: ApiShapedTool[] = []
  for (const schema of schemas) {
    const record = schema as { name?: string; description?: string; input_schema?: unknown }
    if (typeof record.name === 'string' && record.input_schema !== undefined) {
      const tool: ApiShapedTool = {
        name: record.name,
        ...(record.description ? { description: record.description } : {}),
        input_schema: record.input_schema,
      }
      out.push(tool)
    }
  }
  return out
}

async function buildToolDeclarationRows(
  plan: ToolPayloadPlan,
  pool: Tools,
  options: Options,
  model: string,
  build: ToolDeclarationRowBuilder,
): Promise<{ rows: ReadonlyMap<string, ZaiWireMessage>; admitted: readonly ApiShapedTool[] }> {
  const rows = new Map<string, ZaiWireMessage>()
  const admitted: ApiShapedTool[] = []
  for (const declaration of plan.admissionDeclarations) {
    const shaped = await buildApiShapedTools(declaration.tools, options, model, plan.conversationKey, pool)
    if (shaped.length > 0) rows.set(declaration.toolUseId, build(mapToolsToZai(shaped)))
    admitted.push(...shaped)
  }
  return { rows, admitted }
}

type PreparedCompatTurn = {
  credential: CompatCredential
  plan: ToolPayloadPlan
  callableTools: ApiShapedTool[]
  wireModel: string
  imagesSupported: boolean
  deferral: CompatDeferralFacts | undefined
  leadingNotes: string[]
  toolsInPrompt: boolean
  mappedMessages: ReturnType<typeof mapMessagesToZai>
  preparedMessages: Message[]
  makeRequestExtra: () => Record<string, unknown>
  request: CompatChatRequest
  effortOnWire: EffortStampV1
  withEffort: (message: AssistantMessage) => AssistantMessage
}

type FittedCompatTurn = {
  credential: CompatCredential
  plan: ToolPayloadPlan
  apiTools: ApiShapedTool[]
  callableTools: ApiShapedTool[]
  toolDeclarations: ReadonlyMap<string, ZaiWireMessage>
  systemText: string
  wireModel: string
  cacheDomainKey: string
  imagesSupported: boolean
  leadingNotes: string[]
  deferral: CompatDeferralFacts | undefined
  effortView: ReturnType<typeof effortVocabularyFor>
  effortValue: string | undefined
  effortTruth: ReturnType<typeof resolveEffortTruth>
  thinkingEnabled: boolean
  toolsInPrompt: boolean
  fittedImages: RequestImageFit<Message>
}

export async function prepareCompatTurn(
  profile: CompatLaneProfile,
  turnParams: Omit<CompatCallModelParams, 'signal'>,
  modelId: string,
  hasImage: (message: Message) => boolean,
): Promise<FittedCompatTurn | { refusal: AssistantMessage }> {
  const { messages, systemPrompt, thinkingConfig, tools, options } = turnParams
  let credential = await profile.resolveCredential()
  if (credential === undefined) {
    return { refusal: apiErrorMessage(
      `${API_ERROR_MESSAGE_PREFIX}: ${profile.credentialHint} Model '${modelId}' cannot run.`,
    ) }
  }

  const plan = await planToolPayload({
    model: modelId,
    tools,
    messages,
    getToolPermissionContext: options.getToolPermissionContext,
    agents: options.agents,
    latchKey: options.ownerKey ?? String(processOwnerForLane(options.agentId ?? null)),
    hasPendingMcpServers: options.hasPendingMcpServers,
    source: 'query',
  })
  const apiTools = await buildApiShapedTools(plan.roster, options, modelId, plan.conversationKey, plan.roster)
  const declared = await buildToolDeclarationRows(plan, tools, options, modelId, profile.toolDeclarationRow ?? toolDeclarationRowAsText)
  const schemaRefusal = [...apiTools, ...declared.admitted].map(tool => compatToolSchemaRefusal(profile.dialect, tool)).find(refusal => refusal !== undefined)
  if (schemaRefusal !== undefined) {
    return { refusal: apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${schemaRefusal}`, 'invalid_request') }
  }
  const toolDeclarations = declared.rows
  const callableTools = [...apiTools, ...declared.admitted].filter(tool => !plan.isDeferredUnadmitted(tool.name))
  const contract = resolveBehaviourContract([...systemPrompt])
  const systemText = renderGenericInstructions(contract)
  const wireModel = profile.wireModelId(modelId)
  const cacheDomainKey = mintCacheDomainKey({
    providerScope: profile.lane,
    servedModel: wireModel,
    projectPath: getCwd(),
    behaviorContractDigest: stableBehaviourDigest(contract),
    toolSchemaDigest: createHash('sha256')
      .update(JSON.stringify(apiTools.filter(tool => !plan.deferredNames.has(tool.name))))
      .digest('hex')
      .slice(0, 16),
  })
  const imagesSupported = imagesSupportedForCompatModel(modelId)
  const lastAssistant = messages.findLastIndex(message => message.type === 'assistant')
  const imageNotes = profile.lane === 'openai-compat' && !imagesSupported && messages.slice(lastAssistant + 1).some(hasImage)
    ? [`Image content was not sent to the model: ${compatImageRefusalWords(modelId) ?? `${profile.providerLabel} does not accept images for this model — /model picks one that receives images`}. The text is still available.`]
    : []
  const leadingNotes = [...(profile.leadingNotes ?? []), ...imageNotes]
  const deferral: CompatDeferralFacts | undefined = plan.enabled
    ? {
        form: plan.wireForm,
        deferredNames: plan.deferredNames,
        ...(plan.conversationKey !== undefined ? { conversationKey: plan.conversationKey } : {}),
        cacheDomainKey,
        imagesSupported,
      }
    : undefined
  const wireMessages = renderAdmissionRecordsAsText(messages.map(message => (message.type === 'user' ? withToolReferenceTurnBoundary(message) : message)), plan.wireForm)
  const effortView = effortVocabularyFor(modelId)
  const servedEfforts = effortView.kind === 'ladder' || effortView.kind === 'provider' ? effortView.vocabulary : []
  const floorWanted = options.effortPinned === true && options.effortValue === undefined && servedEfforts.length > 0
  const askedEffort = floorWanted ? (floorEffort(servedEfforts) as EffortValue | undefined) : options.effortValue
  const effortContext = { agentId: options.agentId, pinned: options.effortPinned === true }
  const effortValue = resolveWireRequestedEffort(modelId, askedEffort, effortContext)
  const effortTruth = resolveEffortTruth(modelId, askedEffort, effortContext)
  const thinkingEnabled = thinkingConfig.type !== 'disabled'
  const toolsInPrompt = apiTools.length > 0 && profile.toolsInPrompt?.(wireModel) === true
  if (apiTools.length > 0 && !toolsInPrompt && profile.toolCapabilityRefusal) {
    const refusal = profile.toolCapabilityRefusal(wireModel)
    if (refusal !== undefined) {
      return { refusal: apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${refusal}`) }
    }
  }
  const retiredScreenshots = retireOlderScreenshots(wireMessages, undefined, undefined, options.ownerKey ?? String(processOwnerForLane(options.agentId ?? null)))
  const retiredMessages =
    retiredScreenshots.firstEdited === -1
      ? retiredScreenshots.messages
      : stripThinkingFromIndex(retiredScreenshots.messages, retiredScreenshots.firstEdited)
  const fittedImages = await fitImagesToRequestCap(retiredMessages, { model: modelId, owner: options.ownerKey ?? String(processOwnerForLane(options.agentId ?? null)) })
  return { credential, plan, apiTools, callableTools, toolDeclarations, systemText, wireModel, cacheDomainKey, imagesSupported, leadingNotes, deferral, effortView, effortValue, effortTruth, thinkingEnabled, toolsInPrompt, fittedImages }
}

export function openCompatTurn(
  profile: CompatLaneProfile,
  turnParams: Omit<CompatCallModelParams, 'signal'>,
  modelId: string,
  fitted: FittedCompatTurn,
): PreparedCompatTurn | { refusal: AssistantMessage } {
  const { messages, options } = turnParams
  const { credential, plan, apiTools, callableTools, toolDeclarations, systemText, wireModel, cacheDomainKey, imagesSupported, leadingNotes, deferral, effortView, effortValue, effortTruth, thinkingEnabled, toolsInPrompt, fittedImages } = fitted
  const wireMessagesForBridge =
    fittedImages.firstEdited === -1
      ? fittedImages.messages
      : stripThinkingFromIndex(fittedImages.messages, fittedImages.firstEdited)
  let preparedMessages = healWalkableForWire(wireMessagesForBridge)
  const statedMaxOut = operatorModelFacts(modelId)?.maxOutputTokens !== undefined ? getModelMaxOutputTokens(modelId).default : undefined
  const askedOut = options.maxOutputTokensOverride !== undefined
    ? (statedMaxOut !== undefined ? Math.max(options.maxOutputTokensOverride, statedMaxOut) : options.maxOutputTokensOverride)
    : statedMaxOut ?? profile.outputCeiling?.(modelId)
  const outputFit = askedOut === undefined
    ? undefined
    : fitOutputTokensForRequest({ asked: askedOut, messages, model: modelId, fixed: [systemText, apiTools] })
  if (outputFit?.clamped === true) logForDebugging(outputFitWords(outputFit, modelId))
  const fittedOutputOverride = outputFit?.tokens
  const wireTools = mapToolsToZai(apiTools)
  const mapForRequest = (rows: Message[]) => mapMessagesToZai(toolsInPrompt ? toolDialectSystemText(systemText, wireTools) : systemText, toBridgeMessages(rows), {
    keepReasoningHistory: profile.keepsReasoningHistory?.(wireModel, thinkingEnabled) ?? false,
    keepReasoningAfterLastUser: profile.keepsReasoningOnContinuations?.(wireModel) ?? false,
    imagesSupported,
    pdfSupported: (profile.lane === 'gemini' || profile.lane === 'mistral') && modelSupportsPDF(modelId),
    pdfFormat: profile.lane === 'mistral' ? 'document_url' : 'file',
    ...(toolDeclarations.size > 0 ? { toolDeclarations } : {}),
  })
  const servedWindow = profile.servedWindowTokens?.()
  if (servedWindow !== undefined) {
    preparedMessages = fitToolResultImages(preparedMessages, rows => {
      const mapped = mapForRequest(rows)
      return estimateRequestTokens({ messages: toolsInPrompt ? renderToolDialectHistory(mapped) : mapped, tools: toolsInPrompt ? [] : wireTools }, modelId) <= servedWindow
    }).messages
  }
  const mappedMessages = mapForRequest(preparedMessages)
  const slotKey = plan.conversationKey ?? cacheDomainKey
  const makeRequestExtra = (): Record<string, unknown> => {
    const extra = {
      ...laneExtrasWithOperatorEffort(profile, effortView, {
        wireModel,
        effortValue,
        thinkingEnabled,
        maxOutputTokensOverride: fittedOutputOverride,
        conversationKey: slotKey,
        cacheDomainKey,
        crewmate: options.agentId !== undefined,
      }),
      ...(profile.lane === 'openai-compat' || profile.lane === 'openrouter' ? { prompt_cache_key: cacheDomainKey } : {}),
    }
    return extra
  }
  const request: CompatChatRequest = {
    model: wireModel,
    messages: toolsInPrompt ? renderToolDialectHistory(mappedMessages) : mappedMessages,
    ...(apiTools.length > 0 && !toolsInPrompt
      ? {
          tools: wireTools,
          ...(profile.omitsToolChoice ? {} : { tool_choice: options.toolChoice?.type === 'none' ? ('none' as const) : ('auto' as const) }),
        }
      : {}),
    extra: makeRequestExtra(),
  }
  const effortFact =
    profile.effortOnWire?.(request.extra ?? {}) ??
    compatEffortWireFact(request.extra ?? {}, {
      thinkingGated: effortView.kind === 'provider' && effortView.thinkingGated,
      thinkingEnabled,
      supported: effortTruth.supportsEffort,
    })
  const effortOnWire: EffortStampV1 = effortStampOf(effortTruth.requested, effortFact)
  const withEffort = (message: AssistantMessage): AssistantMessage => ({ ...message, effort: effortOnWire })

  if (profile.requestFitRefusal) {
    const requestBytes = JSON.stringify(request).length
    const fitRefusal = profile.requestFitRefusal({
      requestBytes,
      estTokens: estimateRequestTokens(request, modelId),
      toolCount: apiTools.length,
      wireModel,
    })
    if (fitRefusal !== undefined) {
      return { refusal: apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${fitRefusal}`) }
    }
  }

  recordPromptState({
    system: [{ text: systemText }],
    toolSchemas: apiTools,
    querySource: options.querySource,
    model: modelId,
    agentId: options.agentId,
    ...(effortValue ? { effortValue } : {}),
    lane: profile.lane satisfies CacheLane,
    callReference: options.callReference,
  })
  return { credential, plan, callableTools, wireModel, imagesSupported, deferral, leadingNotes, toolsInPrompt, mappedMessages, preparedMessages, makeRequestExtra, request, effortOnWire, withEffort }
}
