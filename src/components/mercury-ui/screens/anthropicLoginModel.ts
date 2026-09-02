import { useEffect, useRef, useState } from 'react'
import { OAuthService } from '../../../services/oauth/index.js'
import { createAndStoreApiKey, shouldUseClaudeAIAuth } from '../../../services/oauth/client.js'
import type { OAuthTokens } from '../../../services/oauth/types.js'
import {
  getOauthAccountInfo,
  loginShadowWarning,
  saveOAuthTokensIfNeeded,
  validateForceLoginOrg,
} from '../../../utils/auth.js'
import { getInitialSettings } from '../../../utils/settings/settings.js'
import { recordSignIn as recordSignInLedger, type SignInKind } from '../../../utils/accounts/signInLedger.js'
import { setClipboard } from '../../../ink/termio/osc.js'
import { logError } from '../../../utils/log.js'


const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60
export const PASTE_PROMPT_DELAY_MS = 3000
export const COPY_ACK_MS = 2000
export const RETRY_DELAY_MS = 1000
export const TOKEN_FINISH_MS = 500

export type AnthropicFlowState =
  | { name: 'idle' }
  | { name: 'ready'; loginWithClaudeAi: boolean }
  | { name: 'waiting'; url: string; loginWithClaudeAi: boolean; forcedMethod: string | null }
  | { name: 'creating-key' }
  | { name: 'success'; token?: string; warning?: string }
  | { name: 'error'; message: string; retry?: AnthropicFlowState }
  | { name: 'about-to-retry'; target: AnthropicFlowState }

export interface AnthropicLoginSnapshot {
  flow: AnthropicFlowState
  pastePromptUp: boolean
  copied: boolean
  shadowWarning: string | null
  accountLabel: string | null
}

export const MANUAL_CODE_ERROR =
  'That is not the full code — copy the complete authorization code (it contains a # separator).'

export const MINT_NO_KEY_ERROR = 'the server accepted the API key request but returned no key'

export const EXCHANGE_RETRY_ERROR = 'The token exchange failed — try again.'

export function parseManualAuthCode(
  raw: string,
): { ok: true; authorizationCode: string; state: string } | { ok: false; message: string } {
  const trimmed = raw.trim()
  const [authorizationCode, stateHalf] = trimmed.split('#')
  if (!authorizationCode || !stateHalf) return { ok: false, message: MANUAL_CODE_ERROR }
  return { ok: true, authorizationCode, state: stateHalf }
}

export function sslHint(error: unknown): string | null {
  const text = String((error as { message?: string })?.message ?? error)
  if (/SSL|certificate|CERT|TLS|self[- ]signed/i.test(text)) {
    return 'The token exchange failed on a TLS/SSL error — a corporate proxy or TLS interception layer is likely rewriting certificates. Configure NODE_EXTRA_CA_CERTS with your organisation root certificate and retry.'
  }
  return null
}

export function exchangeFailureMessage(error: unknown): string {
  return (
    sslHint(error) ??
    (/exchange/i.test(String(error))
      ? EXCHANGE_RETRY_ERROR
      : String((error as Error).message ?? error))
  )
}

export const LOGIN_SUCCESS_NOTICE = {
  key: 'login-success',
  text: 'Signed in',
  priority: 'immediate',
  timeoutMs: 4000,
} as const

export interface AnthropicOAuthServiceLike {
  startOAuthFlow(
    urlCallback: (url: string, manualUrl?: string) => void,
    options: {
      loginWithClaudeAi: boolean
      inferenceOnly?: boolean
      expiresIn?: number
      orgUUID?: string
      loginMethod?: string
    },
  ): Promise<OAuthTokens>
  handleManualAuthCodeInput(input: { authorizationCode: string; state: string }): void
  cleanup(): void
}

export interface AnthropicLoginDeps {
  createService: () => AnthropicOAuthServiceLike
  saveTokens: (tokens: OAuthTokens) => { success: boolean; warning?: string }
  usesClaudeAiAuth: (scopes: string[]) => boolean
  mintApiKey: (accessToken: string) => Promise<unknown>
  validateOrg: () => Promise<unknown>
  accountInfo: () => { emailAddress?: string } | null | undefined
  shadowWarning: () => string | null
  recordSignIn: (kind: SignInKind) => void
  settings: () => { forceLoginMethod?: 'claudeai' | 'console' | null; forceLoginOrgUUID?: string | null }
  notify?: (notice: typeof LOGIN_SUCCESS_NOTICE) => void
  clipboard: (text: string) => Promise<string | null>
  writeStdout: (sequence: string) => void
  log: (error: unknown) => void
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

function liveDeps(): AnthropicLoginDeps {
  return {
    createService: () => new OAuthService(),
    saveTokens: tokens => saveOAuthTokensIfNeeded(tokens),
    usesClaudeAiAuth: scopes => shouldUseClaudeAIAuth(scopes),
    mintApiKey: accessToken => createAndStoreApiKey(accessToken),
    validateOrg: () => validateForceLoginOrg(),
    accountInfo: () => getOauthAccountInfo() as { emailAddress?: string } | null | undefined,
    shadowWarning: () => loginShadowWarning(),
    recordSignIn: kind => recordSignInLedger('anthropic', kind),
    settings: () => getInitialSettings(),
    clipboard: text => setClipboard(text),
    writeStdout: sequence => process.stdout.write(sequence),
    log: error => logError(error),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: handle => clearTimeout(handle as NodeJS.Timeout),
  }
}

export interface AnthropicLoginMachineOptions {
  mode?: 'login' | 'setup-token'
  forceLoginMethod?: 'claudeai' | 'console'
  onDone: () => void
}

export interface AnthropicLoginMachine {
  snapshot(): AnthropicLoginSnapshot
  wake(): void
  start(loginWithClaudeAi: boolean): void
  submitCode(raw: string): boolean
  retry(): void
  copyUrl(): void
  reset(): void
  dispose(): void
}

export function createAnthropicLoginMachine(
  options: AnthropicLoginMachineOptions,
  onChange: (snapshot: AnthropicLoginSnapshot) => void,
  injected?: Partial<AnthropicLoginDeps>,
): AnthropicLoginMachine {
  const deps: AnthropicLoginDeps = { ...liveDeps(), ...injected }
  const setupToken = options.mode === 'setup-token'
  const settingsForced = deps.settings().forceLoginMethod ?? null
  const forcedMethod = options.forceLoginMethod ?? settingsForced ?? null
  const forcedOrg = deps.settings().forceLoginOrgUUID ?? null

  let flow: AnthropicFlowState = setupToken
    ? { name: 'ready', loginWithClaudeAi: true }
    : forcedMethod !== null
      ? { name: 'ready', loginWithClaudeAi: forcedMethod === 'claudeai' }
      : { name: 'idle' }
  let pastePromptUp = false
  let copied = false
  let shadowWarning: string | null = null
  let accountLabel: string | null = null
  let service: AnthropicOAuthServiceLike | null = null
  let started = false
  let disposed = false
  let generation = 0
  const timers = new Set<unknown>()

  const snapshot = (): AnthropicLoginSnapshot => ({ flow, pastePromptUp, copied, shadowWarning, accountLabel })
  const publish = (): void => {
    if (!disposed) onChange(snapshot())
  }
  const arm = (fn: () => void, ms: number): void => {
    const handle = deps.setTimer(() => {
      timers.delete(handle)
      if (!disposed) fn()
    }, ms)
    timers.add(handle)
  }

  const setFlow = (next: AnthropicFlowState): void => {
    if (disposed) return
    flow = next
    if (next.name === 'idle') started = false
    publish()
    if (next.name === 'ready' && !started) {
      started = true
      const loginWithClaudeAi = next.loginWithClaudeAi
      arm(() => startFlow(loginWithClaudeAi), 0)
    }
    if (next.name === 'about-to-retry') {
      const target = next.target
      arm(() => {
        if (target.name === 'ready') started = false
        setFlow(target)
      }, RETRY_DELAY_MS)
    }
  }

  const succeed = async (tokens: OAuthTokens, gen: number): Promise<void> => {
    if (disposed || gen !== generation) return
    if (setupToken) {
      const token = (tokens as { accessToken?: string }).accessToken
      setFlow({ name: 'success', ...(token !== undefined ? { token } : {}) })
      arm(() => options.onDone(), TOKEN_FINISH_MS)
      return
    }
    try {
      const saved = deps.saveTokens(tokens)
      if (!saved.success) {
        throw new Error(saved.warning ?? 'the credential could not be saved to secure storage')
      }
      const saveWarning = saved.warning
      if (!deps.usesClaudeAiAuth(tokens.scopes)) {
        setFlow({ name: 'creating-key' })
        const minted = await deps.mintApiKey(tokens.accessToken)
        if (!minted) throw new Error(MINT_NO_KEY_ERROR)
      }
      if (forcedOrg) {
        const validation = await deps.validateOrg()
        if (validation && (validation as { valid?: boolean }).valid === false) {
          throw new Error(
            (validation as { reason?: string }).reason ??
              'the configured organisation is not valid for this account',
          )
        }
      }
      if (disposed || gen !== generation) return
      deps.recordSignIn(deps.usesClaudeAiAuth(tokens.scopes) ? 'oauth' : 'api-key')
      deps.notify?.(LOGIN_SUCCESS_NOTICE)
      shadowWarning = deps.shadowWarning()
      accountLabel = deps.accountInfo()?.emailAddress ?? null
      setFlow({ name: 'success', ...(saveWarning !== undefined ? { warning: saveWarning } : {}) })
    } catch (error) {
      setFlow({ name: 'error', message: String((error as Error).message ?? error) })
    }
  }

  const startFlow = (loginWithClaudeAi: boolean): void => {
    const gen = generation
    const created = deps.createService()
    service = created
    created
      .startOAuthFlow(
        (autoUrl, manualUrl) => {
          if (gen !== generation) return
          setFlow({ name: 'waiting', url: manualUrl || autoUrl, loginWithClaudeAi, forcedMethod })
          pastePromptUp = false
          publish()
          arm(() => {
            pastePromptUp = true
            publish()
          }, PASTE_PROMPT_DELAY_MS)
        },
        {
          loginWithClaudeAi,
          ...(setupToken ? { inferenceOnly: true, expiresIn: ONE_YEAR_SECONDS } : {}),
          ...(forcedOrg ? { orgUUID: forcedOrg } : {}),
          ...(forcedMethod ? { loginMethod: forcedMethod } : {}),
        },
      )
      .then(tokens => {
        if (gen !== generation) return
        void succeed(tokens, gen)
      })
      .catch(error => {
        if (gen !== generation) return
        deps.log(error)
        const previous = flow
        setFlow({
          name: 'error',
          message: exchangeFailureMessage(error),
          retry: previous.name === 'waiting' ? previous : { name: 'ready', loginWithClaudeAi },
        })
      })
  }

  return {
    snapshot,
    wake(): void {
      if (flow.name === 'ready' && !started) {
        started = true
        const loginWithClaudeAi = flow.loginWithClaudeAi
        arm(() => startFlow(loginWithClaudeAi), 0)
      }
    },
    start(loginWithClaudeAi: boolean): void {
      started = false
      setFlow({ name: 'ready', loginWithClaudeAi })
    },
    submitCode(raw: string): boolean {
      if (flow.name !== 'waiting') return false
      const parsed = parseManualAuthCode(raw)
      if (!parsed.ok) {
        setFlow({ name: 'error', message: parsed.message, retry: flow })
        return false
      }
      service?.handleManualAuthCodeInput({ authorizationCode: parsed.authorizationCode, state: parsed.state })
      return true
    },
    retry(): void {
      if (flow.name !== 'error' || flow.retry === undefined) return
      setFlow({ name: 'about-to-retry', target: flow.retry })
    },
    copyUrl(): void {
      if (flow.name !== 'waiting') return
      void deps.clipboard(flow.url).then(sequence => {
        if (sequence) deps.writeStdout(sequence)
        copied = true
        publish()
        arm(() => {
          copied = false
          publish()
        }, COPY_ACK_MS)
      })
    },
    reset(): void {
      generation += 1
      for (const handle of timers) deps.clearTimer(handle)
      timers.clear()
      service?.cleanup()
      service = null
      started = false
      flow = { name: 'idle' }
      pastePromptUp = false
      copied = false
      shadowWarning = null
      accountLabel = null
      publish()
    },
    dispose(): void {
      disposed = true
      generation += 1
      for (const handle of timers) deps.clearTimer(handle)
      timers.clear()
      service?.cleanup()
    },
  }
}

export function useAnthropicLoginModel(
  options: AnthropicLoginMachineOptions,
  deps?: Partial<AnthropicLoginDeps>,
): AnthropicLoginSnapshot & {
  start: (loginWithClaudeAi: boolean) => void
  submitCode: (raw: string) => boolean
  retry: () => void
  copyUrl: () => void
  reset: () => void
} {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const machineRef = useRef<AnthropicLoginMachine | null>(null)
  const [snap, setSnap] = useState<AnthropicLoginSnapshot | null>(null)
  if (machineRef.current === null) {
    machineRef.current = createAnthropicLoginMachine(
      {
        ...(options.mode !== undefined ? { mode: options.mode } : {}),
        ...(options.forceLoginMethod !== undefined ? { forceLoginMethod: options.forceLoginMethod } : {}),
        onDone: () => optionsRef.current.onDone(),
      },
      next => setSnap(next),
      deps,
    )
  }
  useEffect(() => {
    machineRef.current?.wake()
    return () => {
      machineRef.current?.dispose()
    }
  }, [])
  const machine = machineRef.current
  return {
    ...(snap ?? machine.snapshot()),
    start: loginWithClaudeAi => machine.start(loginWithClaudeAi),
    submitCode: raw => machine.submitCode(raw),
    retry: () => machine.retry(),
    copyUrl: () => machine.copyUrl(),
    reset: () => machine.reset(),
  }
}
