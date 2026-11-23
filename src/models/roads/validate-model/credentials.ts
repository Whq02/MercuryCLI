import type { ValidateModelResult } from './result.js'

export async function validateGeminiModel(): Promise<ValidateModelResult & { skipCache?: boolean }> {
  const { resolveGeminiAccount } = await import(
    '../gemini/geminiAccounts.js'
  )
  if (!resolveGeminiAccount()) {
    return {
      valid: false,
      error: 'Gemini is unavailable — no account (/logins adds Gemini: API key, or Google OAuth with your own client).',
    }
  }
  return { valid: true }
}

export async function validateZaiModel(): Promise<ValidateModelResult & { skipCache?: boolean }> {
  const { resolveZaiApiKey } = await import('../providerDiscovery.js')
  if (!resolveZaiApiKey()) {
    return { valid: false, error: 'Z.AI is unavailable — no API key (/logins zai, or set ZAI_API_KEY).' }
  }
  return { valid: true }
}

export async function validateOrcarouterModel(): Promise<ValidateModelResult & { skipCache?: boolean }> {
  const { resolveOrcarouterAccount } = await import('../orcarouter/orcarouterAccounts.js')
  return resolveOrcarouterAccount() ? { valid: true, skipCache: true } : { valid: false, error: 'OrcaRouter is unavailable — /logins orcarouter connects an account, or set ORCAROUTER_API_KEY.' }
}

export async function validateDeepseekModel(): Promise<ValidateModelResult & { skipCache?: boolean }> {
  const { resolveDeepseekApiKey } = await import(
    '../deepseek/deepseekAccounts.js'
  )
  if (!resolveDeepseekApiKey()) {
    return {
      valid: false,
      error: 'DeepSeek is unavailable — no API key (/logins deepseek, or set DEEPSEEK_API_KEY).',
    }
  }
  return { valid: true }
}

export async function validateCompatModel(trimmed: string): Promise<ValidateModelResult & { skipCache?: boolean }> {
  const { compatModelRefusal } = await import('../openaicompat/compatAccounts.js')
  const error = compatModelRefusal(trimmed)
  return error ? { valid: false, error } : { valid: true, skipCache: true }
}
