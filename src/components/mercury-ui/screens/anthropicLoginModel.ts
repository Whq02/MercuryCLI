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

// ============================================================================
//  anthropicLoginModel — the ONE Anthropic sign-in machine.
//
//  The flow machinery both Anthropic arms ride — claude.ai OAuth and the
//  Console usage-based sign-in whose token exchange mints an API key — for
//  every host that offers them: the /logins card (ConsoleOAuthFlow), the
//  first-run walk's provider station (which mounts that card), and the Boot
//  face's own logins layer. ONE machine, many skins (the sessionPickerModel
//  precedent): the skins own geometry, paint and the paste draft; everything
//  about WHICH state the flow is in, WHAT the sentences say and WHEN the
//  browser/mint/retry beats fire lives here, so no two surfaces can ever
//  disagree about a sign-in.
//
//  The machine is React-free (createAnthropicLoginMachine): timers, the
//  OAuth service, the credential writes and the settings read are injected
//  seams with live defaults, so the prover walks every arm cpu-pure — fake
//  service, fake mint, synchronous timers — and NO live OAuth, browser or
//  key ever runs in a proof. useAnthropicLoginModel binds it to React for
//  the component skins.
// ============================================================================

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60
export const PASTE_PROMPT_DELAY_MS = 3000
export const COPY_ACK_MS = 2000
export const RETRY_DELAY_MS = 1000
export const TOKEN_FINISH_MS = 500

/** The flow's own screens — the vocabulary every skin switches on. */
export type AnthropicFlowState =
  | { name: 'idle' }
  | { name: 'ready'; loginWithClaudeAi: boolean }
  | { name: 'waiting'; url: string; loginWithClaudeAi: boolean; forcedMethod: string | null }
  | { name: 'creating-key' }
  | { name: 'success'; token?: string; warning?: string }
  | { name: 'error'; message: string; retry?: AnthropicFlowState }
  | { name: 'about-to-retry'; target: AnthropicFlowState }

/** What a skin paints from (one snapshot, published on every change). */
export interface AnthropicLoginSnapshot {
  flow: AnthropicFlowState
  /** The waiting screen's paste fallback is up (the 3s beat has passed). */
  pastePromptUp: boolean
  /** The copy ack is showing (2s after a copyUrl). */
  copied: boolean
  /** Success facts (settled sign-ins only; the setup-token arm sets none). */
  shadowWarning: string | null
  accountLabel: string | null
}

/** The manual-paste law: the complete authorization code is `code#state` —
 *  either half missing is refused with this sentence, never submitted. */
export const MANUAL_CODE_ERROR =
  'That is not the full code — copy the complete authorization code (it contains a # separator).'

/** The mint law (the console arm): a server that accepts the API-key
 *  request but returns no key is an ERROR, never a silent half-login. */
export const MINT_NO_KEY_ERROR = 'the server accepted the API key request but returned no key'

/** The exchange-failure canned sentence (non-SSL, non-specific). */
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

/** The startFlow failure mapping: the SSL hint outranks; a generic exchange
 *  failure gets the canned retry sentence; anything else speaks itself. */
export function exchangeFailureMessage(error: unknown): string {
  return (
    sslHint(error) ??
    (/exchange/i.test(String(error))
      ? EXCHANGE_RETRY_ERROR
      : String((error as Error).message ?? error))
  )
}

/** The success notice (the in-chat skin hands it to its notification queue;
 *  a host with no queue paints its own refresh instead). */
export const LOGIN_SUCCESS_NOTICE = {
  key: 'login-success',
  text: 'Signed in',
  priority: 'immediate',
  timeoutMs: 4000,
} as const

/** The service seam — what the machine drives; fakes stand in for proofs. */
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

/** Every read/write the machine performs, injectable whole — live defaults
 *  are the estate's own owners (the SessionPickerFacts pattern). The notify
 *  channel is OPTIONAL BY DESIGN: the in-chat skin hands its notification
 *  queue; the Boot face mounts outside the AppState provider and passes
 *  none — the machine must never require a queue to settle a sign-in. */
export interface AnthropicLoginDeps {
  createService: () => AnthropicOAuthServiceLike
  saveTokens: (tokens: OAuthTokens) => { success: boolean; warning?: string }
  usesClaudeAiAuth: (scopes: string[]) => boolean
  mintApiKey: (accessToken: string) => Promise<unknown>
  validateOrg: () => Promise<unknown>
  accountInfo: () => { emailAddress?: string } | null | undefined
  shadowWarning: () => string | null
  /** The sign-in ledger's record (the computed default orders by it) —
   *  the kind names the arm that landed: the claude.ai grant, or the
   *  Console arm's minted key. */
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
  /** Mount: a machine BORN ready (setup-token · a forced method) arms its
   *  flow here — construction stays side-effect free so a snapshot can be
   *  read before any beat runs. Idempotent; a no-op when born idle. */
  wake(): void
  /** The opening menu's Anthropic picks: idle → ready (the flow starts on
   *  the next beat, once per ready entry). */
  start(loginWithClaudeAi: boolean): void
  /** The waiting screen's paste submit. Parse-refusals land the error state
   *  (retry = the waiting screen) and answer false so the skin clears its
   *  draft; a whole code reaches the pending service and answers true. */
  submitCode(raw: string): boolean
  /** ↵ on a retryable error: error → about-to-retry → the stored target. */
  retry(): void
  /** 'c' on the waiting screen: the URL to the clipboard + the 2s ack. */
  copyUrl(): void
  /** Abandon the flow and return to idle, revivable (a long-lived host —
   *  the Boot face's layer — reopens a fresh flow later): every timer
   *  dies, the pending service is cleaned up, and a LATE settle from the
   *  abandoned flow writes nothing (the generation law). The in-chat card
   *  never needs it (the card unmounts whole). */
  reset(): void
  /** Unmount: release the pending OAuth service and every timer. */
  dispose(): void
}

/**
 * The machine. Behavior is the landed /logins card's, beat for beat:
 * entering 'ready' starts the flow ONCE on a 0-tick beat (re-entry after
 * about-to-retry re-arms); 'waiting' raises the paste fallback after 3s;
 * succeed() saves tokens, mints on console scopes behind 'creating-key'
 * (a keyless mint answer is the MINT_NO_KEY_ERROR), validates a forced
 * org, records the first-login default provider, reads the shadow warning
 * and account label, and lands 'success'; the setup-token arm shows the
 * minted token and auto-finishes after 500ms storing nothing; a startFlow
 * failure maps through exchangeFailureMessage with the waiting screen (or
 * ready) as the retry target; settle failures carry NO retry.
 */
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
  // The reset generation: a flow abandoned by reset() must settle NOTHING
  // when its pending service answers late — every async landing checks the
  // generation it was born under (dispose() bumps it too, same law).
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
    // Entering 'ready' starts the flow once, on the next beat (the landed
    // ready-effect); about-to-retry's landing re-arms through here too.
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
    // A disposed or RESET machine writes NOTHING: the operator left the
    // flow, and a token that settles after that must not store, record or
    // notify — abandonment is total (the service cleanup makes this
    // unreachable live; the guards make it a law).
    if (disposed || gen !== generation) return
    if (setupToken) {
      const token = (tokens as { accessToken?: string }).accessToken
      setFlow({ name: 'success', ...(token !== undefined ? { token } : {}) })
      // Auto-finish without clearing so the token stays visible; it is
      // never written to the keychain.
      arm(() => options.onDone(), TOKEN_FINISH_MS)
      return
    }
    try {
      // THE SAVE TRUTH (prove-login-save-truth): success is only ever
      // announced over a LANDED credential. Both storage legs refusing is
      // an error with a retry — the machine must never record, notify or
      // paint success over nothing. A degraded save (the plaintext
      // fallback carried it) succeeds WITH its warning on the flow.
      const saved = deps.saveTokens(tokens)
      if (!saved.success) {
        throw new Error(saved.warning ?? 'the credential could not be saved to secure storage')
      }
      const saveWarning = saved.warning
      // Console scopes (no claude-ai inference grant) credential the
      // usage-based lane through a MINTED API key. The 'creating-key'
      // screen paints while the mint runs; a keyless answer is an ERROR.
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
      // Disposal or reset during the mint/validate awaits: stop before the
      // record and the notice — the writes behind us were live when they
      // ran.
      if (disposed || gen !== generation) return
      // THE SIGN-IN LEDGER (the neutral-default ruling): the computed
      // default orders by the most recent sign-in, so a landed credential
      // records here — the arm that landed names the kind. Both Anthropic
      // legs converge here; the token-print arm above records nothing.
      deps.recordSignIn(deps.usesClaudeAiAuth(tokens.scopes) ? 'oauth' : 'api-key')
      deps.notify?.(LOGIN_SUCCESS_NOTICE)
      // An environment token would shadow the fresh credential: surface
      // that at login time, not at the next authorisation failure.
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

/** The React binding — one machine per mount, disposed on unmount; the
 *  snapshot is the render input. Skins pass their host-only seams through
 *  `deps` (the in-chat card: its notification queue; the Boot face: none). */
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
        // The done channel reads the ref so a host's re-created closure
        // stays honored without re-creating the machine.
        onDone: () => optionsRef.current.onDone(),
      },
      next => setSnap(next),
      deps,
    )
  }
  useEffect(() => {
    // The mount beat: a machine born ready (setup-token · forced method)
    // starts its flow HERE, never during render — the landed ready-effect.
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
