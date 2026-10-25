import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import { compatChatCallModel, compatLaneLiveProofState, type CompatLaneProfile } from '../openaicompat/compatChatCallModel.js'
import { streamCompatChat, type CompatStreamOptions, type CompatStreamEvent } from '../openaicompat/compatChatClient.js'
import type { LaneExtrasArgs } from '../openaicompat/compatWire.js'
import { configuredProviderKeyCommand, recoverProviderKeyCommand } from '../providerKeyCommand.js'
import { orcarouterApiBase, resolveOrcarouterApiKey } from './orcarouterAccounts.js'
import { orcarouterListedModel, orcarouterQualifiedId, orcarouterWireId, refreshOrcarouterCatalogue } from './orcarouterCatalogue.js'
import { refreshOrcarouterUsage } from './orcarouterUsageState.js'

function buildOrcarouterExtras(args: LaneExtrasArgs): Record<string, unknown> {
  const output = args.maxOutputTokensOverride ?? orcarouterListedModel(orcarouterQualifiedId(args.wireModel))?.outputMax
  return {
    stream_options: { include_usage: true },
    ...(args.effortValue !== undefined ? { reasoning_effort: args.effortValue } : {}),
    ...(output !== undefined ? { max_completion_tokens: output } : {}),
    ...(args.conversationKey ? { prompt_cache_key: args.conversationKey } : {}),
  }
}

async function* orcarouterEvents(options: CompatStreamOptions): AsyncGenerator<CompatStreamEvent> {
  let served: string | null = null
  for await (const event of streamCompatChat({ ...options, onResponseHeaders: (headers, status) => {
    served = headers.get('x-orca-fallback-model') ?? headers.get('x-orca-resolved-model')
    options.onResponseHeaders?.(headers, status)
  } })) {
    if (event.type === 'served-model' && served) yield { type: 'served-model', model: served }
    else if (event.type === 'stream-fault' && ['api-byok:key_unavailable', 'api-model_not_yet_available', 'api-violation_fee.grok.csam'].includes(event.fault.code)) {
      yield { ...event, fault: { ...event.fault, retryable: false } }
    } else yield event
  }
}

const orcarouterLaneProfile: CompatLaneProfile = {
  lane: 'orcarouter', providerLabel: 'OrcaRouter',
  resolveCredential: () => {
    const key = resolveOrcarouterApiKey()
    return key ? { apiKey: key.key } : undefined
  },
  recoverCredential: async () => {
    if (!configuredProviderKeyCommand('orcarouter')) return null
    const key = recoverProviderKeyCommand('orcarouter')
    return key ? { apiKey: key } : undefined
  },
  credentialHint: 'no OrcaRouter API key detected — /logins orcarouter connects an account; ORCAROUTER_API_KEY works too.',
  authRemedy: 'create a current key at orcarouter.ai/console/token and store it with /logins orcarouter, or set ORCAROUTER_API_KEY.',
  billingRemedy: 'add credits at orcarouter.ai/console/billing, then retry.',
  requestUrl: () => `${orcarouterApiBase()}/chat/completions`,
  wireModelId: orcarouterWireId,
  buildExtras: buildOrcarouterExtras,
  extraHeaders: () => ({ 'X-OrcaRouter-Include-Cost': 'true' }),
  streamTransport: options => ({ events: orcarouterEvents(options) }),
  classifyFault: fault => {
    if (fault.code === 'api-insufficient_user_quota') return 'billing_error'
    if (fault.status === 403 || ['api-budget_exceeded', 'api-pre_consume_token_quota_failed', 'api-access_denied', 'api-free_quota_exhausted', 'api-model_not_yet_available', 'api-byok:key_unavailable'].includes(fault.code)) return 'invalid_request'
    return undefined
  },
  policyFaultNote: fault => fault.code === 'api-budget_exceeded'
    ? ' Ask the workspace administrator to raise the member or agent budget.'
    : fault.code === 'api-pre_consume_token_quota_failed'
      ? ' Raise this key’s quota in the OrcaRouter console.'
      : undefined,
  onResponseHeaders: () => {
    void refreshOrcarouterCatalogue().catch(() => {})
    void refreshOrcarouterUsage().catch(() => {})
  },
}

export function orcarouterLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('orcarouter')
}

export async function* orcarouterCallModel(params: CallModelParams): CallModelStream {
  yield* compatChatCallModel(orcarouterLaneProfile, params)
}
