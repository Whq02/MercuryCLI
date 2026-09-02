// ============================================================================
//  providers/openrouter/openrouterAccounts — the OpenRouter account-source
//  owner. Mirrors the OpenAI
//  product shape: ONE account resolver over the credential sources —
//
//    1. **OAuth-minted key** — OpenRouter's real PKCE flow: the user
//       authorizes Mercury at https://openrouter.ai/auth and the exchange
//       MINTS a scoped runtime API key (there is no client id, no state
//       param, and no refresh token in this protocol — the code_verifier
//       binding is the CSRF/interception defense, and the minted key IS the
//       durable credential). Verified against the live OAuth PKCE doc
//
//       authorize `GET /auth?callback_url=…&code_challenge=…&
//       code_challenge_method=S256` (+`key_label` for the headless variant,
//       where the page displays the code on screen); exchange
//       `POST /api/v1/auth/keys` {code, code_verifier, code_challenge_method}
//       → {key}; authorization codes expire 10 minutes after issuance
//       (400 mismatched method · 403 invalid/expired code).
//    2. **API key** — env OPENROUTER_API_KEY WINS (the operator's louder
//       word), else the OAuth-minted key, else the auth-scoped manual store
//       (utils/router/providerSecrets).
//
//  One OpenRouter credential unlocks the whole multi-model catalogue
//  (openrouterCatalogue.ts derives it LIVE) — the wallet entry this module
//  feeds is the seam a future smart-reroute lane consults when a requested
//  class has no direct account.
//
//  Laws (the openaiAccounts precedent, unchanged):
//    - Mercury-owned storage: `.openrouter-auth.json` under the AUTH SCOPE
//      (getAuthConfigHomeDir), durable-atomic, mode 600, versioned, unknown
//      keys preserved;
//    - key VALUES never enter logs, errors, discovery records or UI —
//      presence + source labels + masked tails only;
//    - resolvers are cheap+sync+never-network; the connect flow is the only
//      network act and it is explicit.
// ============================================================================
import { createServer, type Server, type ServerResponse } from 'node:http'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../../../substrate/durablePublish.js'
import { getAuthConfigHomeDir } from '../../../utils/envUtils.js'
import { recordSignIn } from '../../../utils/accounts/signInLedger.js'
import { errorMessageWithCause } from '../../../utils/errors.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getProductUserAgent } from '../../../utils/http.js'
import { openBrowser } from '../../../utils/browser.js'
import {
  generateCodeChallenge,
  generateCodeVerifier,
} from '../../oauth/crypto.js'
import { readStoredOpenrouterApiKey } from '../../../utils/router/providerSecrets.js'

// ── The wire constants ─────────────

/** The user-facing authorize page (NOT under /api). */
const OPENROUTER_AUTH_PAGE = 'https://openrouter.ai/auth'
/** The one API base: /auth/keys (exchange) · /models · /key · /chat/completions. */
const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1'
/** The fixed loopback redirect for the browser flow (OpenRouter registers no
 *  redirect allowlist — callback_url is caller-chosen; :1456 sits beside the
 *  OpenAI flow's registered :1455). Literal 127.0.0.1, not `localhost`: the
 *  listener binds the IPv4 loopback, and IPv6-first localhost resolution
 *  can land on ::1 and refuse — the literal form matches the bind (the
 *  loopback idiom the Gemini flow already uses). */
const OPENROUTER_REDIRECT_PORT = 1456
const openrouterRedirectUri = (port: number): string =>
  `http://127.0.0.1:${port}/auth/callback`
/** The key_label the headless variant asks OpenRouter to stamp on the key. */
const OPENROUTER_KEY_LABEL = 'Mercury'

/** Proof seams (registered in the flag registry): fixture endpoints. The
 *  quoted spellings key the flag-registry consumer-liveness sweep. */
function openrouterAuthPage(env: NodeJS.ProcessEnv = process.env): string {
  return env['MERCURY_OPENROUTER_AUTH_BASE']?.trim() || OPENROUTER_AUTH_PAGE
}
/** One deadline per login/key exchange (the provider-call deadline law). */
const LOGIN_EXCHANGE_TIMEOUT_MS = 15_000

export function openrouterApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return env['MERCURY_OPENROUTER_API_BASE']?.trim() || OPENROUTER_API_BASE
}

// ── Stored auth (Mercury-owned; auth-scoped; mode 600) ──────────────────────

const OPENROUTER_AUTH_VERSION = 1
const AUTH_FILE_NAME = '.openrouter-auth.json'

export interface OpenrouterMintedKey {
  /** The OAuth-minted runtime API key (SECRET — never leaves the store). */
  key: string
  mintedAtMs: number
  /** The key_label requested at mint (non-secret display fact). */
  label?: string
}

interface OpenrouterAuthFile {
  version: number
  minted?: OpenrouterMintedKey
  [k: string]: unknown
}

function authFilePath(): string {
  return join(getAuthConfigHomeDir(), AUTH_FILE_NAME)
}

function readAuthFile(): OpenrouterAuthFile | null {
  try {
    const parsed = JSON.parse(readFileSync(authFilePath(), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as OpenrouterAuthFile
  } catch {
    return null
  }
}

function writeAuthFile(mutate: (file: OpenrouterAuthFile) => OpenrouterAuthFile): void {
  mkdirSync(getAuthConfigHomeDir(), { recursive: true })
  const existing = readAuthFile() ?? { version: OPENROUTER_AUTH_VERSION }
  const next = mutate({ ...existing, version: OPENROUTER_AUTH_VERSION })
  const path = authFilePath()
  // Durable ATOMIC publication (the openaiAccounts law): the store is shared
  // by the foreground, the daemon, and engine-routed children. The minted key
  // never rotates on read (unlike the OpenAI refresh token), so no
  // cross-process refresh lock is needed — atomic whole-file publish alone
  // keeps concurrent writers from tearing it.
  durableAtomicPublishSync(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    /* best-effort on non-POSIX */
  }
}

export function openrouterAuthFileExists(): boolean {
  return existsSync(authFilePath())
}

/** Diagnostic seam — the path only, never contents. */
export function openrouterAuthPathForDisplay(): string {
  return authFilePath()
}

/** The OAuth-minted key record, or undefined. Sync + cheap. */
export function readMintedOpenrouterKey(): OpenrouterMintedKey | undefined {
  const minted = readAuthFile()?.minted
  if (!minted || typeof minted.key !== 'string' || !minted.key.trim()) return undefined
  return minted
}

/** Drop the OAuth-minted key (the connect surface's disconnect). Local drop
 *  only — the key itself is revoked at openrouter.ai/settings/keys (the
 *  caller's copy says so; Mercury holds no provisioning credential). */
export function disconnectOpenrouterOauthKey(): void {
  writeAuthFile(file => {
    const next = { ...file }
    delete next.minted
    return next
  })
}

// ── The account view (never carries a secret) ───────────────────────────────

export type OpenrouterKeySource = 'env' | 'oauth' | 'stored'

export interface OpenrouterAccountRef {
  provider: 'openrouter'
  /** 'oauth-key' = the PKCE-minted credential; 'api-key' = env/manual. Both
   *  bill the same OpenRouter credits — the kind is the CONNECT honesty. */
  kind: 'oauth-key' | 'api-key'
  /** Display label — source facts, never a secret. */
  label: string
  keySource: OpenrouterKeySource
}

/**
 * The ONE OpenRouter key resolution. Precedence: explicit env
 * (OPENROUTER_API_KEY — the operator's louder word) > the OAuth-minted key
 * (the in-product connect) > the auth-scoped manual store. The VALUE never
 * enters records, logs, or errors.
 */
export function resolveOpenrouterApiKey(
  env: NodeJS.ProcessEnv = process.env,
): { key: string; source: OpenrouterKeySource } | undefined {
  const envKey = env.OPENROUTER_API_KEY?.trim()
  if (envKey) return { key: envKey, source: 'env' }
  const minted = readMintedOpenrouterKey()
  if (minted) return { key: minted.key, source: 'oauth' }
  const stored = readStoredOpenrouterApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

/** Source label for display/readiness — never the value. */
export function openrouterKeySource(
  env: NodeJS.ProcessEnv = process.env,
): OpenrouterKeySource | undefined {
  return resolveOpenrouterApiKey(env)?.source
}

/** Resolve the ACTIVE OpenRouter account source (undefined = none). */
export function resolveOpenrouterAccount(
  env: NodeJS.ProcessEnv = process.env,
): OpenrouterAccountRef | undefined {
  const key = resolveOpenrouterApiKey(env)
  if (!key) return undefined
  if (key.source === 'oauth') {
    return {
      provider: 'openrouter',
      kind: 'oauth-key',
      label: 'OpenRouter (OAuth-minted key)',
      keySource: 'oauth',
    }
  }
  return {
    provider: 'openrouter',
    kind: 'api-key',
    label: key.source === 'env' ? 'OpenRouter API key (env)' : 'OpenRouter API key (stored)',
    keySource: key.source,
  }
}

// ── Request-side resolution (base + headers for the active source) ──────────

export interface OpenrouterRequestAuth {
  account: OpenrouterAccountRef
  baseUrl: string
  /** Authorization: Bearer <key>. Never logged. */
  headers: Record<string, string>
}

/** Base+headers for the resolved credential — undefined when none exists
 *  (typed refusal at the caller; never a throw on the read path). */
export function resolveOpenrouterRequestAuth(
  env: NodeJS.ProcessEnv = process.env,
): OpenrouterRequestAuth | undefined {
  const account = resolveOpenrouterAccount(env)
  const key = resolveOpenrouterApiKey(env)
  if (!account || !key) return undefined
  return {
    account,
    baseUrl: openrouterApiBase(env),
    headers: { authorization: `Bearer ${key.key}` },
  }
}

// ── The PKCE connect flow (browser loopback + paste; headless on-page code) ─

export interface OpenrouterConnectHandles {
  /** The URL to open/show. Manual completion: the operator pastes the
   *  redirected URL or the bare code through completeWithRedirect(). */
  authorizeUrl: string
  /** Resolves when the flow completes (listener redirect OR manual paste). */
  result: Promise<OpenrouterAccountRef>
  /** Paste-fallback completion: the full redirected URL, or the raw code
   *  (the headless variant displays the code on the OpenRouter page). */
  completeWithRedirect(pasted: string): void
  /** Abort the flow (closes the loopback listener; result rejects). */
  cancel(reason?: string): void
  /** The listener's bound port once listening (proof seam — ephemeral-port
   *  rigs read the OS assignment); undefined when not listening. */
  boundLoopbackPort(): number | undefined
}

function buildOpenrouterAuthorizeUrl(
  env: NodeJS.ProcessEnv,
  challenge: string,
  mode: 'browser' | 'headless',
  redirectPort: number,
): string {
  // The documented parameter set: callback_url +
  // code_challenge + code_challenge_method for the redirect flow; key_label
  // WITHOUT callback_url for the headless variant (the page then displays
  // the authorization code on screen for manual entry). No client id, no
  // state — the S256 verifier binding is the whole handshake.
  const params = new URLSearchParams({
    ...(mode === 'browser' ? { callback_url: openrouterRedirectUri(redirectPort) } : {}),
    ...(mode === 'headless' ? { key_label: OPENROUTER_KEY_LABEL } : {}),
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  return `${openrouterAuthPage(env)}?${params.toString()}`
}

async function exchangeOpenrouterCode(
  code: string,
  verifier: string,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const url = `${openrouterApiBase(env)}/auth/keys`
  let response: Response
  try {
    // The provider-call deadline law: the key exchange ends within the bound.
    response = await fetchWithProviderDeadline(fetchImpl, 'openrouter', LOGIN_EXCHANGE_TIMEOUT_MS, url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': getProductUserAgent(),
      },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: 'S256',
      }),
      ...(getProxyFetchOptions() as Record<string, unknown>),
    } as RequestInit)
  } catch (error) {
    // Pre-HTTP failure: name the endpoint and the CAUSE chain (the
    // openaiAccounts law — a bare 'fetch failed' hides DNS/TLS/dispatcher
    // faults behind one opaque string).
    throw new Error(
      `openrouter key exchange unreachable (${url}): ${errorMessageWithCause(error)}`,
    )
  }
  if (!response.ok) {
    // Documented: 403 = invalid/expired code (codes live 10 minutes),
    // 400 = mismatched code_challenge_method.
    throw new Error(
      response.status === 403
        ? 'openrouter key exchange refused (HTTP 403) — the authorization code is invalid or expired (codes last 10 minutes); retry the connect'
        : `openrouter key exchange returned HTTP ${response.status}`,
    )
  }
  const parsed = (await response.json()) as Record<string, unknown>
  const key = typeof parsed.key === 'string' ? parsed.key.trim() : ''
  if (!key) throw new Error('openrouter key exchange returned no key')
  return key
}

/**
 * Begin the OpenRouter PKCE connect. Browser mode opens the authorize URL and
 * captures the code via the fixed loopback listener or the paste fallback;
 * headless mode builds the no-callback URL (OpenRouter displays the code
 * on-page) and completes by paste only. The exchange mints the runtime key,
 * which is persisted auth-scoped; the account ref resolves the promise.
 */
export function beginOpenrouterConnect(opts?: {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  mode?: 'browser' | 'headless'
  /** Skip openBrowser() — caller shows the URL. */
  skipBrowserOpen?: boolean
  /** Loopback listener trouble (port busy) — the flow STAYS alive on the
   *  paste fallback; the caller may surface the note. */
  onListenerIssue?: (message: string) => void
  /** Proof seam: bind an ephemeral lane-scoped port (0 = OS-assigned)
   *  instead of the production :1456 — provers must never contend for the
   *  shared fixed port. */
  loopbackPort?: number
  /** THE ABANDON DISCLOSURE (the disclose-not-unwind ruling): an exchange
   *  already in flight when cancel() lands is let COMPLETE — the mint
   *  happened server-side, and dropping the local copy would orphan a live
   *  key on the operator's account. The store lands, the flow promise stays
   *  REJECTED (the cancel), and this fires so the surface can say so
   *  loudly. Never fired by a pre-fire cancel (nothing stores there). */
  onSettledAfterCancel?: (ref: OpenrouterAccountRef) => void
}): OpenrouterConnectHandles {
  const env = opts?.env ?? process.env
  const mode = opts?.mode ?? 'browser'
  const requestedPort = opts?.loopbackPort ?? OPENROUTER_REDIRECT_PORT
  const verifier = generateCodeVerifier()
  const challenge = generateCodeChallenge(verifier)
  const authorizeUrl = buildOpenrouterAuthorizeUrl(env, challenge, mode, requestedPort)
  const fetchImpl = opts?.fetchImpl ?? getApiFetch()

  let settle!: (ref: OpenrouterAccountRef) => void
  let fail!: (error: Error) => void
  const result = new Promise<OpenrouterAccountRef>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  let server: Server | undefined
  let done = false
  let exchangeInFlight = false
  let cancelledMidExchange = false
  // One-settle discipline: the promise settles exactly once, and a cancel
  // must be able to REJECT it even while a completion path holds `done`
  // (the paste path marks done before its exchange starts).
  let settled = false
  const doSettle = (ref: OpenrouterAccountRef): void => {
    if (settled) return
    settled = true
    settle(ref)
  }
  const doFail = (error: Error): void => {
    if (settled) return
    settled = true
    fail(error)
  }

  /** Exchange + persist + settle (shared by both completion paths). A
   *  cancel that landed while the exchange was in flight flips the settle
   *  into the typed disclosure: the store keeps the mint, the promise keeps
   *  the rejection, the surface hears about it. */
  const mint = async (code: string): Promise<void> => {
    exchangeInFlight = true
    try {
      const key = await exchangeOpenrouterCode(code, verifier, fetchImpl, env)
      writeAuthFile(file => ({
        ...file,
        minted: { key, mintedAtMs: Date.now(), label: OPENROUTER_KEY_LABEL },
      }))
      // The mint landed from a sign-in: the ledger the computed default
      // orders by.
      recordSignIn('openrouter', 'oauth')
      // Settle the MINTED identity — the mint is this flow's outcome. (An
      // env pin may still outrank it at dispatch; the wallet/slots surfaces
      // state that shadowing honestly.)
      const ref: OpenrouterAccountRef = {
        provider: 'openrouter',
        kind: 'oauth-key',
        label: 'OpenRouter (OAuth-minted key)',
        keySource: 'oauth',
      }
      if (cancelledMidExchange) {
        opts?.onSettledAfterCancel?.(ref)
        return
      }
      doSettle(ref)
    } finally {
      exchangeInFlight = false
    }
  }

  /** The PASTE path stays terminal: an operator-pasted code that fails to
   *  exchange rejects the flow honestly (a deliberate act, not a stray
   *  network hit). */
  const finish = async (code: string): Promise<void> => {
    if (done || exchangeInFlight) return
    done = true
    try {
      await mint(code)
    } catch (error) {
      doFail(error instanceof Error ? error : new Error(String(error)))
    } finally {
      server?.close()
      server = undefined
    }
  }

  /** The LISTENER path answers by outcome and SURVIVES junk hits: the
   *  protocol has no state parameter to filter on, so any local port-scan,
   *  prefetch, or stray tab can reach the loopback with a bogus code — a
   *  refused exchange keeps the listener alive for the operator's real
   *  redirect instead of aborting the in-flight sign-in. */
  const finishFromListener = async (code: string, res: ServerResponse): Promise<void> => {
    if (done || exchangeInFlight) {
      res
        .writeHead(409, { 'content-type': 'text/plain' })
        .end('Mercury: a sign-in exchange is already underway — return to the terminal.')
      return
    }
    exchangeInFlight = true
    try {
      await mint(code)
      done = true
      res
        .writeHead(200, { 'content-type': 'text/plain' })
        .end('Mercury: OpenRouter connected. You can close this tab.')
      server?.close()
      server = undefined
    } catch (error) {
      exchangeInFlight = false
      // `done` flipping while this exchange ran means the flow ALREADY ended
      // in the terminal (the cancel door, or a terminal paste failure — the
      // only doors past the entry guard). The tab must not claim a wait that
      // no longer exists, and nobody is listening any more (the terminal
      // door closed the server).
      if (done) {
        res
          .writeHead(409, { 'content-type': 'text/plain' })
          .end(
            'Mercury: OpenRouter refused this authorization code and the sign-in already ended in the terminal — start again from /logins.',
          )
        return
      }
      res
        .writeHead(400, { 'content-type': 'text/plain' })
        .end(
          'Mercury: OpenRouter refused this authorization code — the sign-in is still waiting; retry from the terminal or paste the redirected URL.',
        )
      opts?.onListenerIssue?.(
        `a loopback code was refused (${error instanceof Error ? error.message : String(error)}) — still listening; the paste route also completes the sign-in`,
      )
    }
  }

  const extractCode = (pasted: string): string | undefined => {
    const trimmed = pasted.trim()
    try {
      const url = new URL(trimmed)
      return url.searchParams.get('code') ?? undefined
    } catch {
      // The headless variant hands the operator a BARE code to paste.
      return trimmed || undefined
    }
  }

  if (mode === 'browser') {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${requestedPort}`)
      if (url.pathname !== '/auth/callback') {
        res.writeHead(404).end()
        return
      }
      const code = url.searchParams.get('code')
      if (!code) {
        res
          .writeHead(400, { 'content-type': 'text/plain' })
          .end('Mercury: no authorization code on the callback — return to the terminal and retry.')
        return
      }
      void finishFromListener(code, res)
    })
    server.on('error', error => {
      // A bind failure (:1456 taken) must NOT kill the flow — the code still
      // lands in the browser's address bar; the paste fallback completes it.
      server?.close()
      server = undefined
      opts?.onListenerIssue?.(
        `loopback listener unavailable (${error instanceof Error ? error.message : String(error)}) — finish by pasting the redirected URL`,
      )
      if (!opts?.skipBrowserOpen) void openBrowser(authorizeUrl)
    })
    server.listen(requestedPort, '127.0.0.1', () => {
      if (!opts?.skipBrowserOpen) void openBrowser(authorizeUrl)
    })
    server.unref?.()
  } else if (!opts?.skipBrowserOpen) {
    void openBrowser(authorizeUrl)
  }

  const failTerminal = (error: Error): void => {
    if (done) return
    done = true
    server?.close()
    server = undefined
    doFail(error)
  }

  return {
    authorizeUrl,
    result,
    completeWithRedirect(pasted: string): void {
      const code = extractCode(pasted)
      if (!code) {
        failTerminal(new Error('no authorization code found in the pasted value'))
        return
      }
      void finish(code)
    },
    cancel(reason?: string): void {
      // A cancel ALWAYS rejects the flow — past the done-guard, because the
      // paste path holds `done` while its exchange runs. An exchange already
      // in flight is let complete — its landing discloses through
      // onSettledAfterCancel (the ruling: a server-side mint is never
      // orphaned, never silent). Only cancel gets this power: any other
      // terminal door keeps the done-guard, so a stray redirect can never
      // reject a running exchange into a silent store.
      if (exchangeInFlight) cancelledMidExchange = true
      done = true
      server?.close()
      server = undefined
      doFail(new Error(reason ?? 'openrouter connect cancelled'))
    },
    boundLoopbackPort(): number | undefined {
      const address = server?.address()
      return typeof address === 'object' && address !== null ? address.port : undefined
    },
  }
}
