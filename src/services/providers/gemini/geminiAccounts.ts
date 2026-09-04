import { createServer, type Server } from 'node:http'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../../../substrate/durablePublish.js'
import { getAuthConfigHomeDir } from '../../../utils/envUtils.js'
import { errorMessageWithCause } from '../../../utils/errors.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { openBrowser } from '../../../utils/browser.js'
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from '../../oauth/crypto.js'
import { readStoredGeminiApiKey } from '../../../utils/router/providerSecrets.js'
import { recordSignIn, noteCredentialChange } from '../../../utils/accounts/signInLedger.js'


const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const GOOGLE_OAUTH_AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_OAUTH_TOKEN_BASE = 'https://oauth2.googleapis.com/token'
const GEMINI_OAUTH_SCOPE =
  'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/generative-language.retriever'
const GEMINI_REDIRECT_PORT = 1457
const GEMINI_REDIRECT_URI = `http://127.0.0.1:${GEMINI_REDIRECT_PORT}/oauth2/callback`

const LOGIN_EXCHANGE_TIMEOUT_MS = 15_000

export function geminiApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return env['MERCURY_GEMINI_API_BASE']?.trim() || GEMINI_API_BASE
}
function googleOauthAuthBase(env: NodeJS.ProcessEnv = process.env): string {
  return env['MERCURY_GEMINI_OAUTH_AUTH_BASE']?.trim() || GOOGLE_OAUTH_AUTH_BASE
}
function googleOauthTokenBase(env: NodeJS.ProcessEnv = process.env): string {
  return env['MERCURY_GEMINI_OAUTH_TOKEN_BASE']?.trim() || GOOGLE_OAUTH_TOKEN_BASE
}


const GEMINI_AUTH_VERSION = 1
const AUTH_FILE_NAME = '.gemini-auth.json'

export interface GeminiStoredTokens {
  accessToken: string
  refreshToken: string
  accessTokenExpiresAtMs?: number
  scope?: string
}

export interface GeminiOauthClientConfig {
  clientId: string
  clientSecret?: string
}

interface GeminiAuthFile {
  version: number
  client?: GeminiOauthClientConfig
  tokens?: GeminiStoredTokens
  lastRefreshMs?: number
  preferredSource?: 'oauth' | 'api-key'
  [k: string]: unknown
}

function authFilePath(): string {
  return join(getAuthConfigHomeDir(), AUTH_FILE_NAME)
}

function readAuthFile(): GeminiAuthFile | null {
  try {
    const parsed = JSON.parse(readFileSync(authFilePath(), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as GeminiAuthFile
  } catch {
    return null
  }
}

function writeAuthFile(mutate: (file: GeminiAuthFile) => GeminiAuthFile): void {
  mkdirSync(getAuthConfigHomeDir(), { recursive: true })
  const existing = readAuthFile() ?? { version: GEMINI_AUTH_VERSION }
  const next = mutate({ ...existing, version: GEMINI_AUTH_VERSION })
  const path = authFilePath()
  durableAtomicPublishSync(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
  }
  noteCredentialChange()
}

export function geminiAuthFileExists(): boolean {
  return existsSync(authFilePath())
}

export function geminiAuthPathForDisplay(): string {
  return authFilePath()
}


export function geminiOauthClientConfig(
  env: NodeJS.ProcessEnv = process.env,
): (GeminiOauthClientConfig & { source: 'env' | 'stored' }) | undefined {
  const envId = env['MERCURY_GEMINI_OAUTH_CLIENT_ID']?.trim()
  if (envId) {
    const envSecret = env['MERCURY_GEMINI_OAUTH_CLIENT_SECRET']?.trim()
    return { clientId: envId, ...(envSecret ? { clientSecret: envSecret } : {}), source: 'env' }
  }
  const stored = readAuthFile()?.client
  if (stored?.clientId?.trim()) {
    return {
      clientId: stored.clientId.trim(),
      ...(stored.clientSecret?.trim() ? { clientSecret: stored.clientSecret.trim() } : {}),
      source: 'stored',
    }
  }
  return undefined
}

export const GEMINI_CLIENT_STORED_UNVERIFIED_NOTE =
  'Stored as given — proved at the next Google sign-in: invalid_client in the browser tab means a wrong id (esc the wait, reopen this prompt; it starts from the stored id).'

export function writeGeminiOauthClientConfig(config: GeminiOauthClientConfig | null): void {
  writeAuthFile(file => {
    const next = { ...file }
    if (config === null || !config.clientId.trim()) delete next.client
    else
      next.client = {
        clientId: config.clientId.trim(),
        ...(config.clientSecret?.trim() ? { clientSecret: config.clientSecret.trim() } : {}),
      }
    return next
  })
}


export type GeminiKeySource = 'env-google' | 'env-gemini' | 'stored'

export interface GeminiAccountRef {
  provider: 'gemini'
  kind: 'oauth' | 'api-key'
  label: string
  keySource?: GeminiKeySource
}

export function resolveGeminiApiKey(
  env: NodeJS.ProcessEnv = process.env,
): { key: string; source: GeminiKeySource } | undefined {
  const googleKey = env.GOOGLE_API_KEY?.trim()
  if (googleKey) return { key: googleKey, source: 'env-google' }
  const geminiKey = env.GEMINI_API_KEY?.trim()
  if (geminiKey) return { key: geminiKey, source: 'env-gemini' }
  const stored = readStoredGeminiApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

export function geminiOauthConnected(): boolean {
  return Boolean(readAuthFile()?.tokens?.refreshToken)
}

export function geminiOauthRef(): GeminiAccountRef | undefined {
  if (!geminiOauthConnected()) return undefined
  return { provider: 'gemini', kind: 'oauth', label: 'Google account (OAuth)' }
}

export function readPreferredGeminiSource(): 'oauth' | 'api-key' | undefined {
  return readAuthFile()?.preferredSource
}

export function geminiSourceIdentity(
  sourceKind: 'oauth' | 'api-key',
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (sourceKind === 'api-key') return credentialFingerprint(resolveGeminiApiKey(env)?.key)
  const tokens = readAuthFile()?.tokens
  return credentialFingerprint(tokens?.refreshToken ?? tokens?.accessToken)
}

export function writePreferredGeminiSource(kind: 'oauth' | 'api-key' | null): void {
  writeAuthFile(file => {
    const next = { ...file }
    if (kind === null) delete next.preferredSource
    else next.preferredSource = kind
    return next
  })
}

export function resolveGeminiAccount(
  env: NodeJS.ProcessEnv = process.env,
): GeminiAccountRef | undefined {
  const oauth = geminiOauthRef()
  const key = resolveGeminiApiKey(env)
  const keyRef = (): GeminiAccountRef | undefined =>
    key
      ? {
          provider: 'gemini',
          kind: 'api-key',
          label:
            key.source === 'env-google'
              ? 'Gemini API key (GOOGLE_API_KEY env)'
              : key.source === 'env-gemini'
                ? 'Gemini API key (GEMINI_API_KEY env)'
                : 'Gemini API key (stored)',
          keySource: key.source,
        }
      : undefined
  const preferred = readPreferredGeminiSource()
  if (preferred === 'api-key') return keyRef() ?? oauth
  if (preferred === 'oauth') return oauth ?? keyRef()
  return oauth ?? keyRef()
}


const REFRESH_SKEW_MS = 5 * 60_000
let refreshInFlight: Promise<GeminiStoredTokens | undefined> | undefined

function tokensFresh(tokens: GeminiStoredTokens | undefined, nowMs: number): boolean {
  return Boolean(
    tokens?.accessToken &&
      tokens.accessTokenExpiresAtMs !== undefined &&
      tokens.accessTokenExpiresAtMs - nowMs > REFRESH_SKEW_MS,
  )
}

async function postGoogleToken(
  body: URLSearchParams,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const url = googleOauthTokenBase(env)
  let response: Response
  try {
    response = await fetchWithProviderDeadline(fetchImpl, 'gemini', LOGIN_EXCHANGE_TIMEOUT_MS, url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': getUserAgent(),
      },
      body: body.toString(),
      ...(getProxyFetchOptions() as Record<string, unknown>),
    } as RequestInit)
  } catch (error) {
    throw new Error(`google token endpoint unreachable (${url}): ${errorMessageWithCause(error)}`)
  }
  if (!response.ok) {
    let oauthError = ''
    try {
      const body = (await response.json()) as Record<string, unknown>
      if (typeof body.error === 'string' && body.error !== '') oauthError = body.error
    } catch {
    }
    throw new Error(
      `google token endpoint returned HTTP ${response.status}${oauthError ? ` (${oauthError})` : ''}`,
    )
  }
  return (await response.json()) as Record<string, unknown>
}

function tokensFromTokenResponse(
  raw: Record<string, unknown>,
  fallbackRefreshToken: string | undefined,
  now: () => number,
): GeminiStoredTokens {
  const accessToken = typeof raw.access_token === 'string' ? raw.access_token : ''
  const refreshToken =
    typeof raw.refresh_token === 'string' && raw.refresh_token
      ? raw.refresh_token
      : (fallbackRefreshToken ?? '')
  const expiresInS = typeof raw.expires_in === 'number' ? raw.expires_in : undefined
  const scope = typeof raw.scope === 'string' ? raw.scope : undefined
  if (!accessToken) throw new Error('google token endpoint returned no access token')
  return {
    accessToken,
    refreshToken,
    ...(expiresInS !== undefined ? { accessTokenExpiresAtMs: now() + expiresInS * 1000 } : {}),
    ...(scope ? { scope } : {}),
  }
}

export async function currentGeminiTokens(opts?: {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  force?: boolean
}): Promise<GeminiStoredTokens | undefined> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const tokens = readAuthFile()?.tokens
  if (!tokens?.refreshToken) return undefined
  if (!opts?.force && tokensFresh(tokens, now())) return tokens
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      const latest = readAuthFile()?.tokens
      if (
        tokensFresh(latest, now()) &&
        (!opts?.force || latest?.accessToken !== tokens.accessToken)
      ) {
        return latest
      }
      const client = geminiOauthClientConfig(env)
      if (!client) return undefined
      const base = latest?.refreshToken ? latest : tokens
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: base.refreshToken,
        client_id: client.clientId,
        ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
      })
      const raw = await postGoogleToken(body, opts?.fetchImpl ?? getApiFetch(), env)
      const next = tokensFromTokenResponse(raw, base.refreshToken, now)
      writeAuthFile(f => ({ ...f, tokens: next, lastRefreshMs: now() }))
      return next
    } catch (error) {
      if (error instanceof Error && /\binvalid_grant\b/.test(error.message)) {
        writeAuthFile(file => {
          const next = { ...file }
          delete next.tokens
          delete next.lastRefreshMs
          return next
        })
        return undefined
      }
      return readAuthFile()?.tokens ?? tokens
    } finally {
      refreshInFlight = undefined
    }
  })()
  return refreshInFlight
}

export function disconnectGeminiOauth(): void {
  writeAuthFile(file => {
    const next = { ...file }
    delete next.tokens
    delete next.lastRefreshMs
    if (next.preferredSource === 'oauth') delete next.preferredSource
    return next
  })
}


export interface GeminiRequestAuth {
  account: GeminiAccountRef
  baseUrl: string
  headers: Record<string, string>
}

export async function resolveGeminiRequestAuth(opts?: {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  sourceKind?: 'oauth' | 'api-key'
  forceRefresh?: boolean
}): Promise<GeminiRequestAuth | undefined> {
  const env = opts?.env ?? process.env
  const account = resolveGeminiAccount(env)
  const kind = opts?.sourceKind ?? account?.kind
  if (!kind) return undefined
  if (kind === 'api-key') {
    const key = resolveGeminiApiKey(env)
    if (!key) return undefined
    return {
      account: {
        provider: 'gemini',
        kind: 'api-key',
        label:
          key.source === 'env-google'
            ? 'Gemini API key (GOOGLE_API_KEY env)'
            : key.source === 'env-gemini'
              ? 'Gemini API key (GEMINI_API_KEY env)'
              : 'Gemini API key (stored)',
        keySource: key.source,
      },
      baseUrl: geminiApiBase(env),
      headers: { 'x-goog-api-key': key.key },
    }
  }
  const tokens = await currentGeminiTokens({
    ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    env,
    ...(opts?.forceRefresh ? { force: true } : {}),
  })
  if (!tokens?.accessToken) return undefined
  return {
    account: { provider: 'gemini', kind: 'oauth', label: 'Google account (OAuth)' },
    baseUrl: geminiApiBase(env),
    headers: { authorization: `Bearer ${tokens.accessToken}` },
  }
}


export interface GeminiConnectHandles {
  authorizeUrl: string
  result: Promise<GeminiAccountRef>
  completeWithRedirect(pasted: string): void
  cancel(reason?: string): void
  boundLoopbackPort(): number | undefined
}

export function geminiOauthClientMissingCopy(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (geminiOauthClientConfig(env)) return undefined
  return 'Google OAuth needs your own OAuth client (Google Cloud Console → Credentials → OAuth client ID, type "Desktop app"): set MERCURY_GEMINI_OAUTH_CLIENT_ID (+_SECRET) or store it from this screen. API-key sign-in needs no client.'
}

function buildGeminiAuthorizeUrl(
  env: NodeJS.ProcessEnv,
  clientId: string,
  challenge: string,
  state: string,
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: GEMINI_REDIRECT_URI,
    scope: GEMINI_OAUTH_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
  })
  return `${googleOauthAuthBase(env)}?${params.toString()}`
}

export function geminiOauthErrorRemedy(code: string, description?: string): string {
  const detail = description ? ` (${description})` : ''
  if (code === 'access_denied') {
    return (
      'Google refused the sign-in: access_denied' +
      detail +
      ' — your OAuth app is in testing mode and this Google account is not one of its test users. ' +
      'In Google Cloud Console → APIs & Services → OAuth consent screen, add your account under Test users, ' +
      'or publish the app; then retry from /logins.'
    )
  }
  if (code === 'org_internal') {
    return (
      'Google refused the sign-in: org_internal' +
      detail +
      ' — the OAuth app is restricted to its own Google Workspace organization. ' +
      'Sign in with an account from that organization, or set the app user type to External in ' +
      'Google Cloud Console → OAuth consent screen; then retry from /logins.'
    )
  }
  return `Google refused the sign-in: ${code}${detail} — fix the OAuth app in Google Cloud Console, then retry from /logins.`
}

export function beginGeminiBrowserConnect(opts?: {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  skipBrowserOpen?: boolean
  onListenerIssue?: (message: string) => void
  onSettledAfterCancel?: (ref: GeminiAccountRef) => void
  loopbackPort?: number
}): GeminiConnectHandles {
  const env = opts?.env ?? process.env
  const requestedPort = opts?.loopbackPort ?? GEMINI_REDIRECT_PORT
  const client = geminiOauthClientConfig(env)
  const verifier = generateCodeVerifier()
  const challenge = generateCodeChallenge(verifier)
  const state = generateState()
  const authorizeUrl = client ? buildGeminiAuthorizeUrl(env, client.clientId, challenge, state) : ''
  const fetchImpl = opts?.fetchImpl ?? getApiFetch()

  let settle!: (ref: GeminiAccountRef) => void
  let fail!: (error: Error) => void
  const result = new Promise<GeminiAccountRef>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  let server: Server | undefined
  let done = false
  let exchangeInFlight = false
  let cancelledMidExchange = false
  let settled = false
  const doSettle = (ref: GeminiAccountRef): void => {
    if (settled) return
    settled = true
    settle(ref)
  }
  const doFail = (error: Error): void => {
    if (settled) return
    settled = true
    fail(error)
  }

  if (!client) {
    setTimeout(() => fail(new Error(geminiOauthClientMissingCopy(env)!)), 0)
    return {
      authorizeUrl: '',
      result,
      completeWithRedirect: () => {},
      cancel: () => {},
      boundLoopbackPort: () => undefined,
    }
  }

  const finish = async (code: string): Promise<'settled' | 'disclosed' | 'failed' | 'ignored'> => {
    if (done) return 'ignored'
    done = true
    exchangeInFlight = true
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: GEMINI_REDIRECT_URI,
        client_id: client.clientId,
        ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
        code_verifier: verifier,
      })
      const raw = await postGoogleToken(body, fetchImpl, env)
      const tokens = tokensFromTokenResponse(raw, undefined, Date.now)
      if (!tokens.refreshToken) {
        throw new Error(
          'google returned no refresh token — remove the app from your Google account access page and retry the connect',
        )
      }
      writeAuthFile(file => ({
        ...file,
        tokens,
        lastRefreshMs: Date.now(),
        preferredSource: 'oauth',
      }))
      recordSignIn('gemini', 'oauth')
      const ref: GeminiAccountRef = { provider: 'gemini', kind: 'oauth', label: 'Google account (OAuth)' }
      if (cancelledMidExchange) {
        opts?.onSettledAfterCancel?.(ref)
        return 'disclosed'
      }
      doSettle(ref)
      return 'settled'
    } catch (error) {
      doFail(error instanceof Error ? error : new Error(String(error)))
      return 'failed'
    } finally {
      exchangeInFlight = false
      server?.close()
      server = undefined
    }
  }

  const extractCode = (
    pasted: string,
  ): { code?: string; state?: string; error?: string; errorDescription?: string } => {
    const trimmed = pasted.trim()
    try {
      const url = new URL(trimmed)
      return {
        code: url.searchParams.get('code') ?? undefined,
        state: url.searchParams.get('state') ?? undefined,
        error: url.searchParams.get('error') ?? undefined,
        errorDescription: url.searchParams.get('error_description') ?? undefined,
      }
    } catch {
      return { code: trimmed || undefined }
    }
  }

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${requestedPort}`)
    if (url.pathname !== '/oauth2/callback') {
      res.writeHead(404).end()
      return
    }
    const oauthError = url.searchParams.get('error')
    if (oauthError) {
      const remedy = geminiOauthErrorRemedy(
        oauthError,
        url.searchParams.get('error_description') ?? undefined,
      )
      res.writeHead(200, { 'content-type': 'text/plain' }).end(`Mercury: ${remedy}`)
      failTerminal(new Error(remedy))
      return
    }
    const gotState = url.searchParams.get('state')
    const code = url.searchParams.get('code')
    if (!code || gotState !== state) {
      res
        .writeHead(400, { 'content-type': 'text/plain' })
        .end('Mercury: sign-in state mismatch — return to the terminal and retry.')
      return
    }
    void (async () => {
      const end = await finish(code)
      if (end === 'settled' || end === 'disclosed') {
        res
          .writeHead(200, { 'content-type': 'text/plain' })
          .end('Mercury: Google account connected for Gemini. You can close this tab.')
        return
      }
      if (end === 'ignored') {
        res
          .writeHead(409, { 'content-type': 'text/plain' })
          .end('Mercury: a sign-in exchange is already underway — return to the terminal.')
        return
      }
      res
        .writeHead(400, { 'content-type': 'text/plain' })
        .end('Mercury: the Google sign-in could not complete — the terminal has the reason; retry from /logins.')
    })()
  })
  server.on('error', error => {
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
      const extracted = extractCode(pasted)
      if (extracted.error) {
        failTerminal(new Error(geminiOauthErrorRemedy(extracted.error, extracted.errorDescription)))
        return
      }
      if (!extracted.code) {
        failTerminal(new Error('no authorization code found in the pasted value'))
        return
      }
      if (extracted.state && extracted.state !== state) {
        failTerminal(new Error('pasted state does not match this sign-in attempt'))
        return
      }
      void finish(extracted.code)
    },
    cancel(reason?: string): void {
      if (exchangeInFlight) cancelledMidExchange = true
      done = true
      server?.close()
      server = undefined
      doFail(new Error(reason ?? 'gemini connect cancelled'))
    },
    boundLoopbackPort(): number | undefined {
      const address = server?.address()
      return typeof address === 'object' && address !== null ? address.port : undefined
    },
  }
}

export function __resetGeminiAccountsForTest(): void {
  refreshInFlight = undefined
}
