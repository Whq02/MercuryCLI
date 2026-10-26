import { anthropicAccountApiBase } from '../../../constants/oauth.js'
import { saveApiKey } from '../../../utils/auth.js'
import { recordSignIn } from '../../../utils/accounts/signInLedger.js'
import { getUserAgent } from '../../../utils/http.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { ANTHROPIC_WORKSPACE_PROMPT, needsAnthropicWorkspace } from './anthropicWorkspace.js'

export type AnthropicKeyLoginOutcome = {
  ok: boolean
  stored: boolean
  receipt: string
  needsWorkspace?: boolean
}

export async function storeAnthropicApiKeyLogin(
  raw: string,
  options?: { workspaceId?: string; signal?: AbortSignal },
): Promise<AnthropicKeyLoginOutcome> {
  const key = raw.trim()
  const workspaceId = options?.workspaceId?.trim()
  const refused = (receipt: string, needsWorkspace = false): AnthropicKeyLoginOutcome => ({
    ok: false, stored: false, receipt: receipt.split(key).join('[redacted]').replace(/\s+/g, ' ').trim(),
    ...(needsWorkspace ? { needsWorkspace: true } : {}),
  })
  if (!key || !/^[A-Za-z0-9_-]+$/.test(key)) return { ok: false, stored: false, receipt: 'Paste your Anthropic API key.' }
  if (workspaceId && !/^[A-Za-z0-9_-]+$/.test(workspaceId)) return refused('Enter a valid Anthropic workspace ID.', true)
  try {
    const response = await fetchWithProviderDeadline(getApiFetch(), 'anthropic', 15_000, `${anthropicAccountApiBase().replace(/\/+$/, '')}/v1/models?limit=1`, {
      method: 'GET',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'user-agent': getUserAgent(), ...(workspaceId ? { 'anthropic-workspace-id': workspaceId } : {}) },
      ...getProxyFetchOptions({ forAnthropicAPI: true }),
      ...(options?.signal ? { signal: options.signal } : {}),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { message?: unknown }; message?: unknown } | null
      const said = body?.error?.message ?? body?.message
      const message = typeof said === 'string' ? said : `Anthropic refused this key (HTTP ${response.status}).`
      return needsAnthropicWorkspace(message) ? refused(ANTHROPIC_WORKSPACE_PROMPT, true) : refused(message)
    }
    await response.body?.cancel()
    if (options?.signal?.aborted) return refused('Sign-in cancelled.')
    await saveApiKey(key, { workspaceId })
    recordSignIn('anthropic', 'api-key')
    return { ok: true, stored: true, receipt: 'Anthropic API key saved.' }
  } catch (error) {
    return refused(error instanceof Error ? error.message : 'Anthropic did not answer. Try again.')
  }
}
