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

export type VerificationStatus = 'loading' | 'valid' | 'invalid' | 'missing' | 'error'

type Verdict = { status: VerificationStatus; error?: Error }

type KeySource = ReturnType<typeof getAnthropicApiKeyWithSource>['source']

const VALID: Verdict = { status: 'valid' }

const MISSING: Verdict = { status: 'missing' }

const bypassed = (): boolean => !isAnthropicAuthEnabled() || isClaudeAISubscriber()

const helperConfigured = (source: KeySource): boolean => source === 'credentials.keyCommand'

function statusOnFile(): VerificationStatus {
  const { key, source } = getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true })
  return key !== null || helperConfigured(source) ? 'loading' : 'missing'
}

function helperGaveNothing(): Verdict {
  const failure = getApiKeyHelperFailure()
  const detail = failure ? `: ${failure.message}` : ''
  return { status: 'error', error: new Error(`the configured credentials.keyCommand returned no valid key${detail}`) }
}

const faulted = (thrown: unknown): Verdict => ({
  status: 'error',
  error: thrown instanceof Error ? thrown : new Error(String(thrown)),
})

async function resolvedVerdict(opts?: { probe?: boolean }): Promise<Verdict> {
  const nonInteractive = getIsNonInteractiveSession()
  await getApiKeyFromApiKeyHelper(nonInteractive).catch(() => null)
  let resolved: ReturnType<typeof getAnthropicApiKeyWithSource>
  try {
    resolved = getAnthropicApiKeyWithSource()
  } catch {
    return MISSING
  }
  const { key, source } = resolved
  if (key === null) return helperConfigured(source) ? helperGaveNothing() : MISSING
  if (opts?.probe === false) return VALID
  return (await verifyApiKey(key, nonInteractive)) ? VALID : { status: 'invalid' }
}

export function useApiKeyVerification(): {
  status: VerificationStatus
  reverify: (opts?: { probe?: boolean }) => Promise<void>
  error: Error | null
} {
  const [status, setStatus] = useState<VerificationStatus>(() => {
    if (bypassed()) return 'valid'
    try {
      return statusOnFile()
    } catch {
      return 'missing'
    }
  })
  const [error, setError] = useState<Error | null>(null)

  const reverify = useCallback(async (opts?: { probe?: boolean }): Promise<void> => {
    const verdict = bypassed() ? VALID : await resolvedVerdict(opts).catch(faulted)
    setStatus(verdict.status)
    if (verdict.error) setError(verdict.error)
  }, [])

  return useMemo(() => ({ status, reverify, error }), [status, reverify, error])
}
