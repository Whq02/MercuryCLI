
export type ProviderFamilyId =
  | 'anthropic'
  | 'openai'
  | 'zai'
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
export type ProviderModelClass =
  | 'opus'
  | 'sonnet'
  | 'fable'
  | 'gpt'
  | 'glm'
  | 'kimi'
  | 'deepseek'
  | 'grok'
  | 'muse'
  | 'compat'
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
export type ProviderEffortLevel = 'high' | 'xhigh' | 'max'


export type ProviderTransport =
  | 'anthropic-messages'
  | 'openai-responses'
  | 'zai-chat-completions'
  | 'openrouter-chat-completions'
  | 'gemini-generate-content'
  | 'openai-compat-chat-completions'

export const SPECIALIST_ROLES = [
  'advisor',
  'planner',
  'reviewer',
  'debugger',
  'implementer',
  'test-author',
] as const
export type SpecialistRole = (typeof SPECIALIST_ROLES)[number]

export const SPECIALIST_ROLE_ACCESS: Record<SpecialistRole, 'advisory' | 'authoring'> = {
  advisor: 'advisory',
  planner: 'advisory',
  reviewer: 'advisory',
  debugger: 'authoring',
  implementer: 'authoring',
  'test-author': 'authoring',
}

type ProviderCapabilityKey =
  | 'streaming'
  | 'tool-calls'
  | 'structured-output'
  | 'own-agent-loop'
  | 'reasoning-deltas'
  | 'usage-accounting'
  | 'cancellation'
  | 'worktree-authoring'

interface ProviderAccountView {
  kind: 'inherited-main' | 'chatgpt-login' | 'provider-oauth' | 'api-key' | 'keyless' | 'none'
  label: string
}

export interface ProviderCatalogueEntry {
  id: string
  displayLabel: string
  modelClass: ProviderModelClass
  contextWindow?: number
  efforts: readonly string[]
  roles: readonly SpecialistRole[]
}

export interface ProviderDescription {
  transport: ProviderTransport
  capabilities: readonly ProviderCapabilityKey[]
  roles: readonly SpecialistRole[]
  account: ProviderAccountView
  catalogue: readonly ProviderCatalogueEntry[]
  catalogueSource: 'static-pin' | 'live-discovery'
  discoveredAtMs?: number
}

export interface ProviderModelRef {
  provider: ProviderFamilyId
  model: string
  modelClass: ProviderModelClass
  effort: ProviderEffortLevel
  contextWindow: number
}

export interface ProviderModel {
  ref: ProviderModelRef
  displayLabel: string
}

export interface ProviderStatus {
  available: boolean
  reason?: string
}

export interface ProviderAdapter {
  id: ProviderFamilyId
  transport: ProviderTransport
  status(): ProviderStatus
  describe(): ProviderDescription
  listModels(): ProviderModel[]
  resolveModel(modelClass: ProviderModelClass): ProviderModelRef | null
  buildLaunchPatch(ref: ProviderModelRef): { model: string; effort: string }
}
