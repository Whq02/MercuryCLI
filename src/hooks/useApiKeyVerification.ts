// Provider API key verification. The initial probe must not throw
// (a keyless CI boot raises inside a state initialiser and becomes a render
// failure) and must not execute the key helper (settings-sourced code must
// not run before the trust dialog): absence of a key maps to 'missing'.

import { useCallback, useMemo, useState } from 'react'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { verifyApiKey } from '../services/providers/anthropic/index.js'
import {
  getAnthropicApiKeyWithSource,
  getApiKeyFromApiKeyHelper,
  getApiKeyHelperFailure,
  isAnthropicAuthEnabled,
  isClaudeAISubscriber,
} from '../utils/auth.js'

export type VerificationStatus =
  | 'loading'
  | 'valid'
  | 'invalid'
  | 'missing'
  | 'error'

export type ApiKeyVerificationResult = {
  status: VerificationStatus
  reverify: () => Promise<void>
  error: Error | null
}

export function useApiKeyVerification(): ApiKeyVerificationResult {
  const [status, setStatus] = useState<VerificationStatus>(() => {
    if (!isAnthropicAuthEnabled() || isClaudeAISubscriber()) return 'valid'
    try {
      const { key, source } = getAnthropicApiKeyWithSource({
        skipRetrievingKeyFromApiKeyHelper: true,
      })
      if (key !== null) return 'loading'
      // A configured helper (not yet executed) is still pending.
      if (source === 'apiKeyHelper') return 'loading'
      return 'missing'
    } catch {
      // The keyless environment: same answer an absent source gives.
      return 'missing'
    }
  })
  const [error, setError] = useState<Error | null>(null)

  const reverify = useCallback(async (): Promise<void> => {
    if (!isAnthropicAuthEnabled() || isClaudeAISubscriber()) {
      setStatus('valid')
      return
    }
    try {
      // Warm the helper cache (a no-op when unconfigured), then read all
      // sources for real.
      await getApiKeyFromApiKeyHelper(getIsNonInteractiveSession()).catch(
        () => null,
      )
      let resolved: ReturnType<typeof getAnthropicApiKeyWithSource>
      try {
        resolved = getAnthropicApiKeyWithSource()
      } catch {
        // The keyless environment (a credential-less CI boot throws from the
        // ladder): the same answer an absent source gives — 'missing' paints
        // the login row; 'error' would hide it.
        setStatus('missing')
        return
      }
      const { key, source } = resolved
      if (key === null) {
        if (source === 'apiKeyHelper') {
          // Reachable since the helper's failure reads as a null key (FN-015
          // rank 48); the recorded reason rides along.
          const failure = getApiKeyHelperFailure()
          setStatus('error')
          setError(new Error(`the configured apiKeyHelper returned no valid key${failure ? `: ${failure.message}` : ''}`))
          return
        }
        setStatus('missing')
        return
      }
      const valid = await verifyApiKey(key, getIsNonInteractiveSession())
      setStatus(valid ? 'valid' : 'invalid')
    } catch (thrown) {
      setStatus('error')
      setError(thrown instanceof Error ? thrown : new Error(String(thrown)))
    }
  }, [])

  // One object per (status, error) — the REPL's getToolUseContext lists this
  // among its deps and the composer's onSubmit lists getToolUseContext, so a
  // fresh object on every render re-minted both callbacks and re-rendered
  // the memoised composer on every root render (the region matrix's
  // render-reason marks: 24 of 33 composer renders in a stream scene moved
  // only on those identities).
  return useMemo(() => ({ status, reverify, error }), [status, reverify, error])
}
