
import { configuredCompatEndpoints } from '../services/providers/openaicompat/compatAccounts.js'
export type LoginFamilyValue =
  | 'claudeai'
  | 'openai'
  | 'console'
  | 'openrouter'
  | 'gemini'
  | 'huggingface'
  | 'moonshot'
  | 'zai'
  | 'deepseek'
  | 'xai'
  | 'meta'
  | 'mistral'
  | 'nous'
  | 'zen'
  | 'minimax'
  | 'together'
  | 'cohere'
  | 'groq'
  | 'cerebras'
  | 'fireworks'

export interface LoginFamilyRow {
  label: string
  value: LoginFamilyValue | `compat/${string}`
}

export const META_SIGN_IN_ROADS = 'Muse Code sign-in or API key'
export const META_LOGIN_FAMILY_LABEL = `Meta — ${META_SIGN_IN_ROADS}`

export function loginFamilyRows({ engineLegs }: { engineLegs: boolean }): LoginFamilyRow[] {
  return [
    ...(engineLegs
      ? [{ label: 'OpenAI — ChatGPT subscription or API key', value: 'openai' as const }]
      : []),
    { label: 'Claude subscription account', value: 'claudeai' },
    { label: 'Usage-based billing — Anthropic Console sign-in or API key', value: 'console' },
    ...(engineLegs
      ? [
          {
            label: 'OpenRouter — one credential, the whole catalogue (OAuth or key)',
            value: 'openrouter' as const,
          },
          { label: 'Google Gemini — Google sign-in, API key', value: 'gemini' as const },
          {
            label: 'Hugging Face — device-code sign-in or a Hub token (open models)',
            value: 'huggingface' as const,
          },
          { label: 'Kimi (Moonshot) — device-code sign-in or API key', value: 'moonshot' as const },
          { label: 'GLM (Z.AI) — API key (general or GLM Coding Plan)', value: 'zai' as const },
          { label: 'DeepSeek — API key', value: 'deepseek' as const },
          { label: 'xAI — Grok subscription sign-in or API key', value: 'xai' as const },
          { label: META_LOGIN_FAMILY_LABEL, value: 'meta' as const },
          { label: 'Mistral — API key (Mistral Large 4)', value: 'mistral' as const },
          { label: 'Nous Portal — account sign-in or API key (model gateway)', value: 'nous' as const },
          { label: 'MiniMax — API key or M Plan key (M3, M2.7)', value: 'minimax' as const },
          { label: 'Together AI — API key (the gateway\'s chat models)', value: 'together' as const },
          { label: 'Cohere — API key (Command A+, North)', value: 'cohere' as const },
          { label: 'Groq — API key (text models)', value: 'groq' as const },
          { label: 'Cerebras — API key (text models)', value: 'cerebras' as const },
          { label: 'Fireworks — API key (text models)', value: 'fireworks' as const },
          { label: 'OpenCode Zen — API key (one key, the gateway\'s model list)', value: 'zen' as const },
          ...configuredCompatEndpoints().filter(endpoint => endpoint.named).map(endpoint => ({ label: `${endpoint.label} (${endpoint.name}) — endpoint API key`, value: `compat/${endpoint.name}` as const })),
        ]
      : []),
  ]
}

export function loginFamilyInitialFocus<T extends string>(
  rows: readonly { value: T }[],
  recordedFocus: string | undefined,
  initialFocus?: string,
): T | undefined {
  for (const value of [initialFocus, recordedFocus]) {
    const row = rows.find(candidate => candidate.value === value)
    if (row) return row.value
  }
  return rows[0]?.value
}

export const openaiArmPickRows = [
  { label: 'ChatGPT subscription — browser sign-in', value: 'subscription' },
  { label: 'OpenAI API key — paste one (stored locally, mode 600)', value: 'key' },
] as const

export type KeyFamilyValue = Exclude<LoginFamilyValue, 'claudeai' | 'console'>

export const KEY_PAGES: Record<KeyFamilyValue, string> = {
  openai: 'platform.openai.com/api-keys',
  openrouter: 'openrouter.ai/settings/keys',
  gemini: 'aistudio.google.com/apikey',
  huggingface: 'huggingface.co/settings/tokens',
  moonshot: 'platform.kimi.ai',
  zai: 'z.ai/manage-apikey',
  deepseek: 'platform.deepseek.com',
  xai: 'console.x.ai',
  meta: 'dev.meta.ai',
  mistral: 'console.mistral.ai/api-keys',
  nous: 'portal.nousresearch.com',
  zen: 'opencode.ai/auth',
  minimax: 'platform.minimax.io',
  together: 'api.together.ai/settings',
  cohere: 'dashboard.cohere.com/api-keys',
  groq: 'console.groq.com/keys',
  cerebras: 'cloud.cerebras.ai',
  fireworks: 'app.fireworks.ai/api-keys',
}

export const KEY_FAMILIES = Object.keys(KEY_PAGES) as KeyFamilyValue[]

export function keyPageMenuWord(family: KeyFamilyValue): string {
  return family === 'huggingface' ? 'Access Tokens' : 'API Keys'
}

export function keyPageLine(family: KeyFamilyValue): string {
  if (family === 'gemini') return `API key: ${KEY_PAGES[family]} — create a key, paste it here.`
  return `${family === 'huggingface' ? 'Token' : 'API key'}: ${KEY_PAGES[family]} — sign in, ${keyPageMenuWord(family)}, create, paste it here.`
}

export function loginFamilyFocusFor(defaultProvider: string | undefined): LoginFamilyRow['value'] | undefined {
  if (defaultProvider?.startsWith('compat/') && configuredCompatEndpoints().some(endpoint => `compat/${endpoint.name}` === defaultProvider)) return defaultProvider as `compat/${string}`
  switch (defaultProvider) {
    case 'anthropic':
      return 'claudeai'
    case 'openai':
    case 'openrouter':
    case 'gemini':
    case 'huggingface':
    case 'moonshot':
    case 'zai':
    case 'deepseek':
    case 'xai':
    case 'meta':
    case 'mistral':
    case 'nous':
    case 'zen':
    case 'minimax':
    case 'together':
    case 'cohere':
    case 'groq':
    case 'cerebras':
    case 'fireworks':
      return defaultProvider
    default:
      return undefined
  }
}

export const SIGN_IN_LATER_ROW = {
  label: 'Sign in later to look around. The agent needs a sign-in or a local model (/localsetup).',
  value: 'later',
} as const

export interface LocalRoadFacts {
  models: number
  labels: string[]
}

export function localRoadOpen(local: LocalRoadFacts | null | undefined): boolean {
  return local !== null && local !== undefined && local.models > 0 && local.labels.length > 0
}

export function signInLaterRow(local: LocalRoadFacts | null | undefined): { label: string; value: typeof SIGN_IN_LATER_ROW.value } {
  if (!localRoadOpen(local)) return SIGN_IN_LATER_ROW
  return {
    label: `Sign in later to look around, or run a local model — ${local!.models} found on ${local!.labels.join(' · ')}`,
    value: SIGN_IN_LATER_ROW.value,
  }
}

export function loginFamilyNameOf(row: LoginFamilyRow): string {
  return row.label.split(' — ')[0]!
}

export function connectableLoginFamilyWords(): string {
  const names = loginFamilyRows({ engineLegs: true })
    .filter(row => row.value !== 'openai' && row.value !== 'claudeai' && row.value !== 'console')
    .map(loginFamilyNameOf)
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
}
