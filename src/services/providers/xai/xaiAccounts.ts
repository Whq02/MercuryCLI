export const XAI_SURFACES_LANE_STUB = 'stub for the xai surfaces lane — replaced by the xai wire lane at the fold' as const
const XAI_API_BASE_URL = 'https://api.x.ai'

export function xaiApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return env['MERCURY_XAI_API_BASE']?.trim() || XAI_API_BASE_URL
}
export function xaiChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${xaiApiBase(env)}/v1/chat/completions`
}
export function xaiBalanceUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${xaiApiBase(env)}/v1/api-key`
}

export function resolveXaiApiKey(
  _env: Record<string, string | undefined> = process.env,
): { key: string; source: 'env' | 'stored' } | undefined {
  return undefined
}

export interface XaiAccountRef {
  kind: 'api-key'
  label: string
  keySource: 'env' | 'stored'
}

export function resolveXaiAccount(env: NodeJS.ProcessEnv = process.env): XaiAccountRef | undefined {
  const key = resolveXaiApiKey(env)
  if (!key) return undefined
  return {
    kind: 'api-key',
    label: key.source === 'env' ? 'XAI_API_KEY (env)' : 'xAI API key (stored, auth-scoped)',
    keySource: key.source,
  }
}
