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

export type CredentialValueShape = { readonly pattern: RegExp; readonly marker: string } | null

export const PROVIDER_CREDENTIAL_VALUE_SHAPES: Record<CallModelRoute, CredentialValueShape> = {
  anthropic: { pattern: /(?<![A-Za-z0-9"'])sk-ant-[A-Za-z0-9_-]{10,}(?![A-Za-z0-9"'])/g, marker: '[REDACTED_API_KEY]' },
  openai: { pattern: /(?<![A-Za-z0-9"'])sk-(?!ant-|or-v1-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9"'])/g, marker: '[REDACTED_OPENAI_KEY]' },
  zai: null,
  moonshot: null,
  deepseek: null,
  'openai-compat': null,
  openrouter: { pattern: /(?<![A-Za-z0-9"'])sk-or-v1-[A-Za-z0-9]{20,}(?![A-Za-z0-9"'])/g, marker: '[REDACTED_OPENROUTER_KEY]' },
  gemini: { pattern: /(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9])/g, marker: '[REDACTED_GCP_KEY]' },
  huggingface: { pattern: /(?<![A-Za-z0-9"'])hf_[A-Za-z0-9]{20,}(?![A-Za-z0-9"'])/g, marker: '[REDACTED_HUGGINGFACE_TOKEN]' },
  local: null,
}

export const REPOSITORY_HOST_TOKEN_SHAPE: NonNullable<CredentialValueShape> = {
  pattern: /(?<![A-Za-z0-9])(?:ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})(?![A-Za-z0-9])/g,
  marker: '[REDACTED_GITHUB_TOKEN]',
}

export const CREDENTIAL_VALUE_PASSES: readonly NonNullable<CredentialValueShape>[] = [
  ...Object.values(PROVIDER_CREDENTIAL_VALUE_SHAPES).filter((shape): shape is NonNullable<CredentialValueShape> => shape !== null),
  REPOSITORY_HOST_TOKEN_SHAPE,
]
