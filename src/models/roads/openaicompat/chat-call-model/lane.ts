import type { Tools } from '../../../../tools/kit/tool.js'
import type {
  AssistantMessage,
  Message,
} from '../../../../engine/message-shapes/message.js'
import type { Options } from '../../anthropic/streamCore.js'
import { type EffortWireFact } from '../../../effort/effortStamp.js'
import { thinkingOffWireEffort } from '../compatWire.js'
import { nearestSupportedWireEffort } from '../../../facts/pins/gptPins.js'
import { normalizeModelStringForAPI } from '../../../catalogue/engineModel.js'
import type { SystemPrompt } from '../../../../engine/system-prompt/systemPromptType.js'
import type { ThinkingConfig } from '../../../effort/thinking.js'
import { type ToolDeclarationRowBuilder } from '../../zai/zaiCodec.js'
import { effortVocabularyFor, modelReceivesImageBlocks } from '../../../facts/capabilities.js'
import { imageRefusalOf } from '../../../../integrations/desktop/desktopSession.js'
import { compatModelImageReading } from '../compatProbe.js'
import {
  type CompatFault,
  type CompatLivenessReading,
  type CompatRuntimeReading,
  type CompatStreamEvent,
  type CompatStreamOptions,
  type CompatUsage,
} from '../compatChatClient.js'

export type CompatLaneId =
  | 'moonshot'
  | 'deepseek'
  | 'xai'
  | 'meta'
  | 'openai-compat'
  | 'openrouter'
  | 'gemini'
  | 'huggingface'
  | 'local'
  | 'mistral'
  | 'nous'
  | 'zen'
  | 'minimax'
  | 'together'
  | 'cohere'
  | 'groq'
  | 'melious'
  | 'orcarouter'
  | 'cerebras'
  | 'fireworks'
  | 'qwen'

export function imagesSupportedForCompatModel(model: string): boolean {
  const reading = compatModelImageReading(model)
  return reading !== undefined ? reading.supported : modelReceivesImageBlocks(model) && imageRefusalOf(model) === null
}

export function compatDispatchModelId(model: string): string {
  return normalizeModelStringForAPI(model.trim())
}

export interface CompatCredential {
  apiKey?: string
  requestUrl?: string
  accountIdentity?: string
}

export interface CompatLaneProfile {
  lane: CompatLaneId
  dialect?: string
  prefillTokensPerSecond?(): Promise<number | undefined>
  liveness?(pinnedSlot: number | undefined): Promise<CompatLivenessReading>
  streamTransport?(options: CompatStreamOptions, messages: readonly Message[]): {
    events: AsyncGenerator<CompatStreamEvent>
    settle?(messages: readonly AssistantMessage[]): void
  } | undefined
  effortOnWire?(extra: Record<string, unknown>): EffortWireFact
  usageForSettlement?(usage: CompatUsage): CompatUsage
  noteRuntime?(reading: { runtime: CompatRuntimeReading | undefined; usage: CompatUsage | undefined; served: string | undefined }): void
  policyFaultNote?(fault: CompatFault, extra: Record<string, unknown> | undefined): string | undefined
  classifyFault?(fault: CompatFault): NonNullable<AssistantMessage['error']> | undefined
  recordsSignInRefusal?(fault: CompatFault): boolean
  leadingNotes?: readonly string[]
  partialFaultPolicy?: 'stop'
  providerLabel: string
  resolveCredential(): CompatCredential | undefined | Promise<CompatCredential | undefined>
  credentialHint: string
  authRemedy?: string
  billingRemedy?: string
  recoverCredential?(): Promise<CompatCredential | undefined | null>
  requestUrl(): string
  wrapFetch?(fetchImpl: typeof fetch): typeof fetch
  wireModelId(modelId: string): string
  requestFitRefusal?(estimate: { requestBytes: number; estTokens: number; toolCount: number; wireModel: string }): string | undefined
  servedWindowTokens?(): number | undefined
  onResponseHeaders?(headers: Headers, status?: number): void
  onCredentialRefused?(fault: Pick<CompatFault, 'status' | 'code' | 'message'>): void
  extraHeaders?(): Record<string, string> | undefined
  omitsToolChoice?: boolean
  toolCapabilityRefusal?(wireModel: string): string | undefined
  toolsInPrompt?(wireModel: string): boolean
  outputCeiling?(modelId: string): number | undefined
  buildExtras(args: {
    wireModel: string
    effortValue: string | undefined
    thinkingEnabled: boolean
    maxOutputTokensOverride: number | undefined
    conversationKey?: string
    cacheDomainKey?: string
    crewmate?: boolean
  }): Record<string, unknown>
  refusesEffort?(wireEffort: string): boolean
  keepsReasoningHistory?(wireModel: string, thinkingEnabled?: boolean): boolean
  keepsReasoningOnContinuations?(wireModel: string): boolean
  noteServedModel?(requested: string, served: string, credential: CompatCredential): void
  toolDeclarationRow?: ToolDeclarationRowBuilder
}

export interface CompatCallModelParams {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}

export function laneExtrasWithOperatorEffort(
  profile: Pick<CompatLaneProfile, 'lane' | 'buildExtras' | 'refusesEffort'>,
  effortView: ReturnType<typeof effortVocabularyFor>,
  args: Parameters<CompatLaneProfile['buildExtras']>[0],
): Record<string, unknown> {
  const operatorEffort =
    effortView.kind === 'provider' && effortView.source === 'operator' && effortView.vocabulary.length > 0
      ? !args.thinkingEnabled && effortView.thinkingGated
        ? thinkingOffWireEffort(effortView.vocabulary)
        : args.effortValue !== undefined
          ? effortView.vocabulary.includes(args.effortValue)
            ? args.effortValue
            : nearestSupportedWireEffort(args.effortValue, effortView.vocabulary)
          : undefined
      : undefined
  const builtExtras = profile.buildExtras(args)
  return profile.lane !== 'openai-compat' && operatorEffort !== undefined && profile.refusesEffort?.(operatorEffort) !== true && builtExtras.reasoning_effort === undefined && builtExtras.reasoning === undefined
    ? { ...builtExtras, reasoning_effort: operatorEffort }
    : builtExtras
}
