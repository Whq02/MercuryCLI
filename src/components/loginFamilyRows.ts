
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
      return defaultProvider
    default:
      return undefined
  }
}

export const SIGN_IN_LATER_ROW = {
  label: 'Sign in later — look around first (running turns needs a sign-in)',
  value: 'later',
} as const
