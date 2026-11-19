import { processOwnerForLane } from '../../../run/resolveOwner.js'
import { createHash } from 'node:crypto'
import { getCwd } from '../../../../utils/cwd.js'
import { mintCacheDomainKey } from '../../../../utils/cache/cacheDomain.js'
import type { Tools } from '../../../../Tool.js'
import type {
  AssistantMessage,
} from '../../../../types/message.js'
import type { CallModelParams } from '../../callModelContract.js'
import {
  recordPromptState,
  type NeutralToolSchema,
} from '../../../api/promptCacheBreakDetection.js'
import type { Options } from '../../anthropic/streamCore.js'
import { toolToAPISchema } from '../../../../utils/api.js'
import { withToolReferenceTurnBoundary } from '../../../../utils/messages/apiView.js'
import { applyStripTargetsToMessages, errorDrivenStripTargets } from '../../../../utils/messages/apiPlan.js'
import type { ApiShapedTool } from '../../zai/zaiCodec.js'
import {
  renderOpenaiInstructions,
  resolveBehaviourContract,
  stableBehaviourDigest,
} from '../../../../prompt/behaviourContract.js'
import { openaiCacheRetention } from '../openaiCacheRetention.js'
import { getModelMaxOutputTokens, modelSupportsPDF } from '../../../../utils/model/capabilities.js'
import { operatorModelFacts } from '../../../../utils/model/modelOverrides.js'
import {
  buildOpenaiResponsesRequest,
} from '../responsesBridge.js'
import {
  ensureOpenaiGatewayProbe,
  gatewayProbePolicyAllows,
} from '../../deferralProbe.js'
import { openaiGatewayHost } from '../../deferralWire.js'
import { logForDebugging } from '../../../../utils/debug.js'
import { planToolPayload, renderAdmissionRecordsAsText } from '../../toolEconomy.js'
import { fitWireImages } from '../../../../utils/messages/imageRequestFit.js'
import { OPENAI_IMAGE_LIMITS } from '../../../../constants/apiLimits.js'
import { admitOpenaiTurn } from './admitTurn.js'
import { resolveTurnEffort } from './turnEffort.js'
import { bridgeTurnMessages } from './bridgeMessages.js'
import { sendOpenaiGatewayProbe } from './gatewayProbe.js'
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

export async function* prepareOpenaiTurn(
  params: CallModelParams,
  deferralFormReissued: string | undefined,
  resumeTrimReissued: string | undefined,
): AsyncGenerator<AssistantMessage, OpenaiTurn | undefined> {
  const { systemPrompt, tools, signal, options } = params
  const admitted = yield* admitOpenaiTurn(params)
  if (admitted === undefined) return
  const { conversation4xxKey, messages, prior4xxCode, auth, qualification, modelId, candidate } = admitted

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

  const { imagesRide, bridge } = await bridgeTurnMessages(wireMessages, options, modelId, candidate, settlementNotes)

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
    toolSchemas: apiTools as unknown as NeutralToolSchema[],
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
    busy: undefined,
    reconnect: undefined,
    emptyEnds: 0,
    emptyEnd: false,
  }
}
