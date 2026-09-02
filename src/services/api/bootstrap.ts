import axios from 'axios'
import { z } from 'zod'

import { getOauthConfig, OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import {
  getAnthropicApiKey,
  getClaudeAIOAuthTokens,
  hasProfileScope,
} from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { withOAuth401Retry } from '../../utils/http.js'
import { logError } from '../../utils/log.js'
import type { ModelOption } from '../../utils/model/modelOptions.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { getAnthropicClientUserAgent } from '../../utils/userAgent.js'

/**
 * One-shot startup fetch of server-provided client data + extra model
 * options into the global config cache. Never rejects.
 */

const BOOTSTRAP_TIMEOUT_MS = 5000

const bootstrapResponseSchema = z.object({
  client_data: z.record(z.string(), z.unknown()).nullable().optional(),
  additional_model_options: z
    .array(
      z.object({
        model: z.string(),
        name: z.string(),
        description: z.string(),
      }),
    )
    .nullable()
    .optional(),
})

type BootstrapData = {
  clientData: Record<string, unknown> | null
  modelOptions: ModelOption[]
}

async function fetchBootstrapResponse(): Promise<BootstrapData | undefined> {
  if (isEssentialTrafficOnly()) {
    logForDebugging('bootstrap: skipped (essential traffic only)')
    return undefined
  }
  const hasOauth = getClaudeAIOAuthTokens()?.accessToken != null && hasProfileScope()
  // The key accessor throws by design in keyless CI; probes carry the guard.
  let hasApiKey = false
  try {
    hasApiKey = getAnthropicApiKey() != null
  } catch {
    hasApiKey = false
  }
  if (!hasOauth && !hasApiKey) {
    logForDebugging('bootstrap: skipped (no usable auth)')
    return undefined
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/claude_cli/bootstrap`
  let response: { data: unknown }
  try {
    response = await withOAuth401Retry(async () => {
      // Re-read the token INSIDE the retry so a refreshed token is picked
      // up. API-key sessions have no refresh mechanism and fail through.
      const accessToken = getClaudeAIOAuthTokens()?.accessToken
      const useOauth = accessToken != null && hasProfileScope()
      const apiKey = getAnthropicApiKey()
      if (!useOauth && apiKey == null) {
        logForDebugging('bootstrap: no auth available at request time')
        throw new Error('bootstrap: no auth available')
      }
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': getAnthropicClientUserAgent(),
        ...(useOauth
          ? {
              Authorization: `Bearer ${accessToken}`,
              'anthropic-beta': OAUTH_BETA_HEADER,
            }
          : { 'x-api-key': apiKey as string }),
      }
      return axios.get(url, { headers, timeout: BOOTSTRAP_TIMEOUT_MS })
    })
  } catch (err) {
    const status = axios.isAxiosError(err)
      ? (err.response?.status ?? err.code ?? 'unknown')
      : 'unknown'
    logForDebugging(`bootstrap: fetch failed (${String(status)})`)
    throw err
  }

  const parsed = bootstrapResponseSchema.safeParse(response.data)
  if (!parsed.success) {
    logForDebugging(`bootstrap: response validation failed: ${String(parsed.error)}`)
    return undefined
  }
  return {
    clientData: parsed.data.client_data ?? null,
    // Wire names {model, name, description} → picker names at the boundary.
    modelOptions: (parsed.data.additional_model_options ?? []).map(option => ({
      value: option.model,
      label: option.name,
      description: option.description,
    })),
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/** The public entry point: fetch and persist. Never rejects. */
export async function fetchBootstrapData(): Promise<void> {
  try {
    const data = await fetchBootstrapResponse()
    if (data === undefined) return
    const config = getGlobalConfig()
    const currentClientData = config.clientDataCache ?? null
    const currentOptions = config.additionalModelOptionsCache ?? []
    if (deepEqual(currentClientData, data.clientData) && deepEqual(currentOptions, data.modelOptions)) {
      logForDebugging('bootstrap: unchanged, skipping config write')
      return
    }
    saveGlobalConfig(current => ({
      ...current,
      clientDataCache: data.clientData,
      additionalModelOptionsCache: data.modelOptions,
    }))
  } catch (err) {
    logError(err)
  }
}
