
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

export interface LoginFamilyRow {
  label: string
  value: LoginFamilyValue
}

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
          { label: 'Google Gemini — API key or Google OAuth', value: 'gemini' as const },
          {
            label: 'Hugging Face — device-code sign-in or a Hub token (open models)',
            value: 'huggingface' as const,
          },
          { label: 'Kimi (Moonshot) — device-code sign-in or API key', value: 'moonshot' as const },
          { label: 'GLM (Z.AI) — API key (general or GLM Coding Plan)', value: 'zai' as const },
          { label: 'DeepSeek — API key', value: 'deepseek' as const },
          { label: 'xAI — Grok subscription sign-in or API key', value: 'xai' as const },
          { label: 'Meta — API key (Muse)', value: 'meta' as const },
          { label: 'Mistral — API key (Mistral Large 4)', value: 'mistral' as const },
          { label: 'Nous Portal — API key (model gateway)', value: 'nous' as const },
          { label: 'OpenCode Zen — API key (one key, the gateway\'s model list)', value: 'zen' as const },
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
}

export const KEY_FAMILIES = Object.keys(KEY_PAGES) as KeyFamilyValue[]

export function keyPageMenuWord(family: KeyFamilyValue): string {
  return family === 'huggingface' ? 'Access Tokens' : 'API Keys'
}

export function keyPageLine(family: KeyFamilyValue): string {
  if (family === 'gemini') return `API key: ${KEY_PAGES[family]} — create a key, paste it here.`
  return `${family === 'huggingface' ? 'Token' : 'API key'}: ${KEY_PAGES[family]} — sign in, ${keyPageMenuWord(family)}, create, paste it here.`
}

export function loginFamilyFocusFor(defaultProvider: string | undefined): LoginFamilyValue | undefined {
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
      return defaultProvider
    default:
      return undefined
  }
}

export const SIGN_IN_LATER_ROW = {
  label: 'Sign in later to look around. Sign-in is required to run the agent.',
  value: 'later',
} as const
