
export type RouterProviderId =
  | 'anthropic'
  | 'openai'
  | 'zai'
  | 'moonshot'
  | 'deepseek'
  | 'openai-compat'
  | 'openrouter'
  | 'gemini'
  | 'huggingface'
  | 'local'
export type RouterModelClass =
  | 'opus'
  | 'sonnet'
  | 'fable'
  | 'gpt'
  | 'glm'
  | 'kimi'
  | 'deepseek'
  | 'compat'
  | 'huggingface'
  | 'local'
export type RouteEffortLevel = 'high' | 'xhigh' | 'max'
export type RouterPosture = 'adaptive' | 'quality' | 'balanced' | 'fast' | 'fixed'


export type RouterTransport =
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
export const isSpecialistRole = (v: unknown): v is SpecialistRole =>
  typeof v === 'string' && (SPECIALIST_ROLES as readonly string[]).includes(v)

export const SPECIALIST_ROLE_ACCESS: Record<SpecialistRole, 'advisory' | 'authoring'> = {
  advisor: 'advisory',
  planner: 'advisory',
  reviewer: 'advisory',
  debugger: 'authoring',
  implementer: 'authoring',
  'test-author': 'authoring',
}

export type ProviderCapabilityKey =
  | 'streaming'
  | 'tool-calls'
  | 'structured-output'
  | 'own-agent-loop'
  | 'reasoning-deltas'
  | 'usage-accounting'
  | 'cancellation'
  | 'worktree-authoring'

export interface ProviderAccountView {
  kind: 'inherited-main' | 'chatgpt-login' | 'provider-oauth' | 'api-key' | 'keyless' | 'none'
  label: string
}

export interface ProviderCatalogueEntry {
  id: string
  displayLabel: string
  modelClass: RouterModelClass
  contextWindow?: number
  efforts: readonly string[]
  roles: readonly SpecialistRole[]
}

export interface ProviderDescription {
  transport: RouterTransport
  capabilities: readonly ProviderCapabilityKey[]
  roles: readonly SpecialistRole[]
  account: ProviderAccountView
  catalogue: readonly ProviderCatalogueEntry[]
  catalogueSource: 'static-pin' | 'live-discovery'
  discoveredAtMs?: number
}

export interface RouteModelRef {
  provider: RouterProviderId
  model: string
  modelClass: RouterModelClass
  effort: RouteEffortLevel
  contextWindow: number
}

export interface RouterProviderModel {
  ref: RouteModelRef
  displayLabel: string
}

export interface RouterProviderStatus {
  available: boolean
  reason?: string
}

export interface RouterProviderAdapter {
  id: RouterProviderId
  transport: RouterTransport
  status(): RouterProviderStatus
  describe(): ProviderDescription
  listModels(): RouterProviderModel[]
  resolveModel(modelClass: RouterModelClass, posture: RouterPosture): RouteModelRef | null
  buildLaunchPatch(ref: RouteModelRef): { model: string; effort: string }
}
