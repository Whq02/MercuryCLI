import type { CallModelRoute } from './idSpaces.js'

export const PROVIDER_CREDENTIAL_ENV_VARS: Record<CallModelRoute, readonly string[]> = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  openai: ['OPENAI_API_KEY'],
  zai: ['ZAI_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  huggingface: ['HF_TOKEN'],
  'openai-compat': ['MERCURY_COMPAT_API_KEY'],
  local: ['MERCURY_LOCAL_API_KEY'],
}

export const ALL_PROVIDER_CREDENTIAL_ENV_VARS: readonly string[] = [
  ...new Set(Object.values(PROVIDER_CREDENTIAL_ENV_VARS).flat()),
]
