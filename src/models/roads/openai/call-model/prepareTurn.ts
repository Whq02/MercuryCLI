import { processOwnerForLane } from '../../../../engine/run-owner/resolveOwner.js'
import { createHash } from 'node:crypto'
import { getCwd } from '../../../../platform/files/cwd.js'
import { mintCacheDomainKey } from '../../../../platform/cache-clock/cacheDomain.js'
import type { Tools } from '../../../../tools/kit/tool.js'
import type {
  AssistantMessage,
  Message,
} from '../../../../engine/message-shapes/message.js'
import type { CallModelParams } from '../../callModelContract.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../../../engine/requests/apiErrorRows.js'
import { openTurnRetries } from '../../../../engine/requests/withRetry.js'
import type { OpenaiFault } from '../openaiWire.js'
import {
  recordPromptState,
} from '../../../../engine/requests/promptCacheBreakDetection.js'
import type { Options } from '../../anthropic/streamCore.js'
import { toolToAPISchema } from '../../../../engine/messages/apiSystemAndToolSchema.js'
import { withToolReferenceTurnBoundary } from '../../../../engine/messages/apiView.js'
import { applyStripTargetsToMessages, errorDrivenStripTargets } from '../../../../engine/messages/apiPlan.js'
import type { ApiShapedTool } from '../../zai/zaiCodec.js'
import {
  renderOpenaiInstructions,
  resolveBehaviourContract,
  stableBehaviourDigest,
} from '../../../../engine/system-prompt/behaviourContract.js'
import {
  resolveOpenaiAccount,
  resolveOpenaiRequestAuth,
  type OpenaiRequestAuth,
} from '../openaiAccounts.js'
import {
  type GptCandidate,
  type GptReasoningProfile,
} from '../openaiCatalogue.js'
import { type EffortAdjustedV1 } from '../../../effort/effort.js'
import { openaiCacheRetention } from '../openaiCacheRetention.js'
import { getModelMaxOutputTokens, modelSupportsPDF } from '../../../facts/capabilities.js'
import { operatorModelFacts } from '../../../catalogue/modelOverrides.js'
import {
  buildOpenaiResponsesRequest,
} from '../responsesBridge.js'
import {
  ensureOpenaiGatewayProbe,
  gatewayProbePolicyAllows,
} from '../../deferralProbe.js'
import { openaiGatewayHost } from '../../deferralWire.js'
import { logForDebugging } from '../../../../platform/logs/debugLog.js'
import { planToolPayload, renderAdmissionRecordsAsText, type ToolPayloadPlan } from '../../toolEconomy.js'
import { retireOlderScreenshots } from '../../../../integrations/desktop/screenshotRetention.js'
import { fitImagesToRequestCap, type RequestImageFit } from '../../../../platform/images/imageResizer.js'
import { stripThinkingFromIndex } from '../../../../engine/messages/apiFilters.js'
import { fitWireImages } from '../../../../engine/message-shapes/imageRequestFit.js'
import { OPENAI_IMAGE_LIMITS } from '../../mediaLimits.js'
import { resolveTurnEffort, type TurnEffort } from './turnEffort.js'
import { bridgeFittedMessages } from './bridgeMessages.js'
import { sendOpenaiGatewayProbe } from './gatewayProbe.js'
import { OPENAI_MAX_ATTEMPTS, apiErrorMessage, openaiRetryDelayMs } from './faults.js'
import { qualifyRequestedModel } from './qualify.js'
import type { OpenaiTurn } from './turnState.js'

async function buildApiShapedTools(
  tools: Tools,
  options: Options,
  model: string,
  conversationKey?: string,
): Promise<ApiShapedTool[]> {
  const schemas = await Promise.all(
    tools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext: options.getToolPermissionContext,
        tools,
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
      out.push({
        name: record.name,
        ...(record.description ? { description: record.description } : {}),
        input_schema: record.input_schema,
      })
    }
  }
  return out
}

export type TurnOpening = {
  params: CallModelParams
  deferralFormReissued: string | undefined
  resumeTrimReissued: string | undefined
  systemPrompt: CallModelParams['systemPrompt']
  tools: CallModelParams['tools']
  signal: CallModelParams['signal']
  options: CallModelParams['options']
  requestedId: string
  conversation4xxKey: string
  messages: Message[]
  prior4xxCode: string | undefined
  account: NonNullable<ReturnType<typeof resolveOpenaiAccount>>
}

type PreparedOpenaiTurn = {
  auth: OpenaiRequestAuth
  modelId: string
  candidate: GptCandidate | undefined
  plan: ToolPayloadPlan
  nativeDeferral: boolean
  apiTools: ApiShapedTool[]
  requestedEffort: TurnEffort['requestedEffort']
  effortTruth: TurnEffort['effortTruth']
  profile: GptReasoningProfile
  receiptOf: TurnEffort['receiptOf']
  effortAdjusted: EffortAdjustedV1 | undefined
  settlementNotes: string[]
  fittedImages: RequestImageFit<Message>
}

export async function prepareOpenaiTurn(opening: TurnOpening): Promise<PreparedOpenaiTurn | { refusal: AssistantMessage }> {
  const { deferralFormReissued, resumeTrimReissued, tools, signal, options, requestedId, messages, account } = opening
  let auth = await resolveOpenaiRequestAuth({ sourceKind: account.kind })
  if (!auth) {
    return { refusal: apiErrorMessage(
      `${API_ERROR_MESSAGE_PREFIX}: the ${account.label} source failed to produce request credentials (expired/revoked sign-in or missing key) — reconnect the OpenAI account. Model '${requestedId}' cannot run.`,
    ) }
  }

  const qualification = await qualifyRequestedModel(requestedId, auth)
  if (qualification.kind === 'refused') {
    return { refusal: apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${qualification.message}`) }
  }
  const modelId = qualification.modelId
  const candidate = qualification.kind === 'ok' ? qualification.candidate : undefined

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
  const nativeDeferral = plan.enabled && plan.wireForm === 'openai-native'
  if (plan.enabled && plan.wireWhy === 'gateway-unprobed' && gatewayProbePolicyAllows()) {
    const endpoint = openaiGatewayHost()
    if (!endpoint.firstParty && endpoint.host !== null) {
      const probeAuth = auth
      void ensureOpenaiGatewayProbe(endpoint.host, body => sendOpenaiGatewayProbe(body, probeAuth, signal), modelId)
    }
  }
  const apiTools = await buildApiShapedTools(plan.roster, options, modelId, plan.conversationKey)
  const strippedMessages = applyStripTargetsToMessages(messages, errorDrivenStripTargets(messages))
  const projectedMessages = strippedMessages.map(message => message.type === 'user' ? withToolReferenceTurnBoundary(message) : message)
  const wireMessages = renderAdmissionRecordsAsText(projectedMessages)
  const { remembered, requestedEffort, effortTruth, profile, receiptOf, effortAdjusted } = resolveTurnEffort(modelId, candidate, options, auth)
  const settlementNotes: string[] = []
  if (qualification.kind === 'degraded') {
    if (remembered === undefined) settlementNotes.push(qualification.note)
    else logForDebugging(qualification.note, { level: 'info' })
  }
  if (deferralFormReissued !== undefined) settlementNotes.push(deferralFormReissued)
  if (resumeTrimReissued !== undefined) settlementNotes.push(resumeTrimReissued)

  const retiredScreenshots = retireOlderScreenshots(wireMessages, undefined, undefined, options.ownerKey ?? String(processOwnerForLane(options.agentId ?? null)))
  const retiredMessages =
    retiredScreenshots.firstEdited === -1
      ? retiredScreenshots.messages
      : stripThinkingFromIndex(retiredScreenshots.messages, retiredScreenshots.firstEdited)
  const fittedImages = await fitImagesToRequestCap(retiredMessages, { model: modelId, owner: options.ownerKey ?? String(processOwnerForLane(options.agentId ?? null)) })
  return { auth, modelId, candidate, plan, nativeDeferral, apiTools, requestedEffort, effortTruth, profile, receiptOf, effortAdjusted, settlementNotes, fittedImages }
}

export function openOpenaiTurn(opening: TurnOpening, prepared: PreparedOpenaiTurn): OpenaiTurn {
  const { params, deferralFormReissued, resumeTrimReissued, systemPrompt, tools, signal, options, conversation4xxKey, messages, prior4xxCode } = opening
  const { auth, modelId, candidate, plan, nativeDeferral, apiTools, requestedEffort, effortTruth, profile, receiptOf, effortAdjusted, settlementNotes, fittedImages } = prepared
  const { imagesRide, bridge } = bridgeFittedMessages(fittedImages, options, modelId, candidate, settlementNotes)

  const contract = resolveBehaviourContract([...systemPrompt])
  const renderedInstructions = renderOpenaiInstructions(contract)
  const promptCacheKey = mintCacheDomainKey({
    providerScope: `openai:${auth.account.kind}`,
    servedModel: modelId,
    projectPath: getCwd(),
    behaviorContractDigest: stableBehaviourDigest(contract),
    toolSchemaDigest: createHash('sha256').update(JSON.stringify(apiTools)).digest('hex').slice(0, 16),
    ...(options.agentId ? { profileId: `agent:${options.agentId}` } : {}),
  })
  const statedMaxOut = auth.account.kind === 'api-key' && operatorModelFacts(modelId)?.maxOutputTokens !== undefined ? getModelMaxOutputTokens(modelId).default : undefined
  const cacheSourceKind = auth.account.kind
  const buildRequest = (wireEffort: string | undefined) => fitWireImages({ ...buildOpenaiResponsesRequest({
    model: modelId,
    instructions: renderedInstructions,
    messages: bridge.rows,
    tools: apiTools,
    ...(wireEffort ? { reasoningEffort: wireEffort } : {}),
    ...(statedMaxOut !== undefined ? { maxOutputTokens: statedMaxOut } : {}),
    promptCacheKey,
    imagesSupported: imagesRide,
    pdfSupported: imagesRide && modelSupportsPDF(modelId),
    ...(options.outputFormat ? { outputFormat: options.outputFormat } : {}),
    ...(options.nativeWebSearch ? { nativeWebSearch: options.nativeWebSearch } : {}),
    ...(nativeDeferral ? { deferredToolNames: plan.deferredNames, toolSearch: true } : {}),
    ...(options.toolChoice?.type === 'none' ? { toolChoice: 'none' as const } : {}),
  }), ...openaiCacheRetention(modelId, cacheSourceKind) }, OPENAI_IMAGE_LIMITS).request
  let request = buildRequest(profile.wireEffort)

  recordPromptState({
    system: [{ text: request.instructions ?? '' }],
    toolSchemas: apiTools,
    querySource: options.querySource,
    model: modelId,
    agentId: options.agentId,
    effortValue: profile.wireEffort,
    lane: 'openai',
    callReference: options.callReference,
  })

  const turnStartedAtMs = Date.now()
  return {
    params,
    deferralFormReissued,
    resumeTrimReissued,
    signal,
    tools,
    options,
    conversation4xxKey,
    messages,
    prior4xxCode,
    modelId,
    candidate,
    plan,
    nativeDeferral,
    requestedEffort,
    effortTruth,
    receiptOf,
    settlementNotes,
    contract,
    buildRequest,
    turnStartedAtMs,
    auth,
    profile,
    effortAdjusted,
    request,
    recovery: undefined,
    retries: openTurnRetries<OpenaiFault>({
      signal,
      maxAttempts: OPENAI_MAX_ATTEMPTS,
      backoffMs: openaiRetryDelayMs,
      provider: 'OpenAI',
      log: '[openai]',
      agent: options.agentId !== undefined,
      singleShot: options.querySource === 'overload_probe',
      ...(options.onWait !== undefined ? { onWait: options.onWait } : {}),
    }),
  }
}
