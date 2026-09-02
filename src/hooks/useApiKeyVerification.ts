
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
      if (source === 'apiKeyHelper') return 'loading'
      return 'missing'
    } catch {
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
      await getApiKeyFromApiKeyHelper(getIsNonInteractiveSession()).catch(
        () => null,
      )
      let resolved: ReturnType<typeof getAnthropicApiKeyWithSource>
      try {
        resolved = getAnthropicApiKeyWithSource()
      } catch {
        setStatus('missing')
        return
      }
      const { key, source } = resolved
      if (key === null) {
        if (source === 'apiKeyHelper') {
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

  return useMemo(() => ({ status, reverify, error }), [status, reverify, error])
}
