import { createServer, type Server } from 'node:http'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
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
import { readStoredOpenaiApiKey } from '../../../utils/router/providerSecrets.js'
import { recordSignIn } from '../../../utils/accounts/signInLedger.js'


const OPENAI_AUTH_ISSUER = 'https://auth.openai.com'
const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OPENAI_OAUTH_REDIRECT_PORT = 1455
const OPENAI_OAUTH_REDIRECT_URI = `http://localhost:${OPENAI_OAUTH_REDIRECT_PORT}/auth/callback`
const OPENAI_OAUTH_SCOPE =
  'openid profile email offline_access api.connectors.read api.connectors.invoke'
const OPENAI_CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const OPENAI_API_BASE_URL = 'https://api.openai.com/v1'

function openaiIssuerBase(env: NodeJS.ProcessEnv = process.env): string {
  return env['MERCURY_OPENAI_AUTH_BASE']?.trim() || OPENAI_AUTH_ISSUER
}
function openaiChatgptBase(env: NodeJS.ProcessEnv = process.env): string {
  return env['MERCURY_OPENAI_CHATGPT_BASE']?.trim() || OPENAI_CHATGPT_BASE_URL
}
function openaiApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return env['MERCURY_OPENAI_API_BASE']?.trim() || OPENAI_API_BASE_URL
}


const OPENAI_AUTH_VERSION = 1
const AUTH_FILE_NAME = '.openai-auth.json'

const LOGIN_EXCHANGE_TIMEOUT_MS = 15_000

export interface OpenaiStoredTokens {
  idToken: string
  accessToken: string
  refreshToken: string
  accountId?: string
  planType?: string
  email?: string
  accessTokenExpiresAtMs?: number
}

interface OpenaiAuthFile {
  version: number
  tokens?: OpenaiStoredTokens
  lastRefreshMs?: number
  preferredSource?: 'chatgpt-subscription' | 'api-key'
  [k: string]: unknown
}

function authFilePath(): string {
  return join(getAuthConfigHomeDir(), AUTH_FILE_NAME)
}

function readAuthFile(): OpenaiAuthFile | null {
  try {
    const parsed = JSON.parse(readFileSync(authFilePath(), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as OpenaiAuthFile
  } catch {
    return null
  }
}

function writeAuthFile(mutate: (file: OpenaiAuthFile) => OpenaiAuthFile): void {
  const dir = getAuthConfigHomeDir()
  mkdirSync(dir, { recursive: true })
  const existing = readAuthFile() ?? { version: OPENAI_AUTH_VERSION }
  const next = mutate({ ...existing, version: OPENAI_AUTH_VERSION })
  const path = authFilePath()
  durableAtomicPublishSync(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
  }
}

export function openaiAuthFileExists(): boolean {
  return existsSync(authFilePath())
}

export function openaiAuthPathForDisplay(): string {
  return authFilePath()
}


function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split('.')
  if (parts.length < 2) return undefined
  try {
    const json = Buffer.from(parts[1]!, 'base64url').toString('utf8')
    const parsed = JSON.parse(json) as unknown
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function openaiAuthClaims(idToken: string): Record<string, unknown> {
  const payload = decodeJwtPayload(idToken)
  const nest = payload?.['https://api.openai.com/auth']
  return typeof nest === 'object' && nest !== null
    ? (nest as Record<string, unknown>)
    : {}
}

function jwtExpiryMs(token: string): number | undefined {
  const payload = decodeJwtPayload(token)
  const exp = payload?.exp
  return typeof exp === 'number' ? exp * 1000 : undefined
}

export function tokensFromExchange(raw: {
  id_token: string
  access_token: string
  refresh_token: string
}): OpenaiStoredTokens {
  const claims = openaiAuthClaims(raw.id_token)
  const accountId =
    typeof claims.chatgpt_account_id === 'string' ? claims.chatgpt_account_id : undefined
  const planType =
    typeof claims.chatgpt_plan_type === 'string' ? claims.chatgpt_plan_type : undefined
  const topLevel = decodeJwtPayload(raw.id_token)
  const emailClaim = topLevel?.email
  const email =
    typeof emailClaim === 'string' && emailClaim.trim() !== '' ? emailClaim.trim() : undefined
  const expiresAt = jwtExpiryMs(raw.access_token)
  return {
    idToken: raw.id_token,
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    ...(accountId ? { accountId } : {}),
    ...(planType ? { planType } : {}),
    ...(email ? { email } : {}),
    ...(expiresAt ? { accessTokenExpiresAtMs: expiresAt } : {}),
  }
}


export type OpenaiAccountSourceKind = 'chatgpt-subscription' | 'api-key'

export interface OpenaiAccountRef {
  provider: 'openai'
  kind: OpenaiAccountSourceKind
  label: string
  accountId?: string
  planType?: string
  email?: string
  keySource?: 'env' | 'stored'
}

export function subscriptionConnected(): boolean {
  const file = readAuthFile()
  return Boolean(file?.tokens?.refreshToken)
}

export function openaiSubscriptionPresence(): {
  state: 'connected' | 'expired' | 'absent'
  email?: string
  planType?: string
} {
  const tokens = readAuthFile()?.tokens
  if (!tokens) return { state: 'absent' }
  const identity = {
    ...(tokens.email ? { email: tokens.email } : {}),
    ...(tokens.planType ? { planType: tokens.planType } : {}),
  }
  return tokens.refreshToken ? { state: 'connected', ...identity } : { state: 'expired', ...identity }
}

export function openaiSubscriptionRef(): OpenaiAccountRef | undefined {
  const tokens = readAuthFile()?.tokens
  if (!tokens?.refreshToken) return undefined
  return {
    provider: 'openai',
    kind: 'chatgpt-subscription',
    label: tokens.planType ? `ChatGPT ${tokens.planType} subscription` : 'ChatGPT subscription',
    ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
    ...(tokens.planType ? { planType: tokens.planType } : {}),
    ...(tokens.email ? { email: tokens.email } : {}),
  }
}

export function resolveOpenaiApiKey(
  env: NodeJS.ProcessEnv = process.env,
): { key: string; source: 'env' | 'stored' } | undefined {
  const envKey = env.OPENAI_API_KEY?.trim()
  if (envKey) return { key: envKey, source: 'env' }
  const stored = readStoredOpenaiApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

export function readPreferredOpenaiSource(): OpenaiAccountSourceKind | undefined {
  const file = readAuthFile()
  return file?.preferredSource
}

export function openaiSourceIdentity(
  sourceKind: OpenaiAccountSourceKind,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (sourceKind === 'api-key') return credentialFingerprint(resolveOpenaiApiKey(env)?.key)
  const tokens = readAuthFile()?.tokens
  return credentialFingerprint(tokens?.refreshToken ?? tokens?.accountId ?? tokens?.accessToken)
}

export function writePreferredOpenaiSource(kind: OpenaiAccountSourceKind | null): void {
  writeAuthFile(file => {
    const next = { ...file }
    if (kind === null) delete next.preferredSource
    else next.preferredSource = kind
    return next
  })
}

export function resolveOpenaiAccount(
  env: NodeJS.ProcessEnv = process.env,
): OpenaiAccountRef | undefined {
  const file = readAuthFile()
  const sub = file?.tokens?.refreshToken ? file.tokens : undefined
  const key = resolveOpenaiApiKey(env)
  const preferred = file?.preferredSource

  const subscriptionRef = (): OpenaiAccountRef | undefined =>
    sub
      ? {
          provider: 'openai',
          kind: 'chatgpt-subscription',
          label: sub.planType
            ? `ChatGPT ${sub.planType} subscription`
            : 'ChatGPT subscription',
          ...(sub.accountId ? { accountId: sub.accountId } : {}),
          ...(sub.planType ? { planType: sub.planType } : {}),
          ...(sub.email ? { email: sub.email } : {}),
        }
      : undefined
  const apiKeyRef = (): OpenaiAccountRef | undefined =>
    key
      ? {
          provider: 'openai',
          kind: 'api-key',
          label: `OpenAI API key (${key.source})`,
          keySource: key.source,
        }
      : undefined

  if (preferred === 'api-key') return apiKeyRef() ?? subscriptionRef()
  if (preferred === 'chatgpt-subscription') return subscriptionRef() ?? apiKeyRef()
  return subscriptionRef() ?? apiKeyRef()
}


const REFRESH_SKEW_MS = 5 * 60_000
const REFRESH_LOCK_STALE_MS = 30_000
const REFRESH_WAIT_TOTAL_MS = 8_000
const REFRESH_WAIT_STEP_MS = 200
let refreshInFlight: Promise<OpenaiStoredTokens | undefined> | undefined

const knownDeadRefreshTokens = new Set<string>()

function isTerminalGrantRefusal(error: unknown): boolean {
  const e = error as { httpStatus?: number; oauthErrorCode?: string } | null
  return (
    typeof e?.httpStatus === 'number' &&
    e.httpStatus >= 400 &&
    e.httpStatus < 500 &&
    e.oauthErrorCode === 'invalid_grant'
  )
}

function blankDeadRefreshTokenOnDisk(usedRefreshToken: string): void {
  try {
    if (readAuthFile()?.tokens?.refreshToken !== usedRefreshToken) return
    writeAuthFile(file => {
      const stored = file.tokens
      if (!stored || stored.refreshToken !== usedRefreshToken) return file
      return { ...file, tokens: { ...stored, refreshToken: '' } }
    })
  } catch {
  }
}

function refreshLockPath(): string {
  return `${authFilePath()}.refresh-lock`
}

function tokensFresh(tokens: OpenaiStoredTokens | undefined, nowMs: number): boolean {
  return Boolean(
    tokens?.accessToken &&
      tokens.accessTokenExpiresAtMs !== undefined &&
      tokens.accessTokenExpiresAtMs - nowMs > REFRESH_SKEW_MS,
  )
}

function acquireRefreshLock(nowMs: number): boolean {
  const path = refreshLockPath()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      try {
        writeSync(fd, `${process.pid} ${nowMs}\n`)
      } finally {
        closeSync(fd)
      }
      return true
    } catch {
      try {
        const stamp = readFileSync(path, 'utf8')
        const stampedAt = Number(stamp.trim().split(/\s+/)[1])
        if (Number.isFinite(stampedAt) && nowMs - stampedAt > REFRESH_LOCK_STALE_MS) {
          unlinkSync(path)
          continue
        }
      } catch {
      }
      return false
    }
  }
  return false
}

export function refreshLockStampedBy(path: string, pid: number): boolean {
  try {
    const holder = Number(readFileSync(path, 'utf8').trim().split(/\s+/)[0])
    return !Number.isFinite(holder) || holder === pid
  } catch {
    return false
  }
}

function releaseRefreshLock(): void {
  const path = refreshLockPath()
  if (!refreshLockStampedBy(path, process.pid)) return
  try {
    unlinkSync(path)
  } catch {
  }
}

async function postTokenEndpoint(
  body: URLSearchParams,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<{ id_token: string; access_token: string; refresh_token: string }> {
  const url = `${openaiIssuerBase(env)}/oauth/token`
  let response: Response
  try {
    response = await fetchWithProviderDeadline(fetchImpl, 'openai', LOGIN_EXCHANGE_TIMEOUT_MS, url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': getUserAgent(),
      },
      body: body.toString(),
      ...(getProxyFetchOptions() as Record<string, unknown>),
    } as RequestInit)
  } catch (error) {
    throw new Error(
      `openai token endpoint unreachable (${url}): ${errorMessageWithCause(error)}`,
    )
  }
  if (!response.ok) {
    let oauthError = ''
    try {
      const errorBody = (await response.json()) as Record<string, unknown>
      if (typeof errorBody.error === 'string') oauthError = errorBody.error
    } catch {
    }
    const error = new Error(
      `openai token endpoint returned HTTP ${response.status}${oauthError ? ` (${oauthError})` : ''}`,
    ) as Error & { httpStatus?: number; oauthErrorCode?: string }
    error.httpStatus = response.status
    if (oauthError) error.oauthErrorCode = oauthError
    throw error
  }
  const parsed = (await response.json()) as Record<string, unknown>
  const id_token = typeof parsed.id_token === 'string' ? parsed.id_token : ''
  const access_token = typeof parsed.access_token === 'string' ? parsed.access_token : ''
  const refresh_token =
    typeof parsed.refresh_token === 'string' ? parsed.refresh_token : ''
  if (!access_token) throw new Error('openai token endpoint returned no access token')
  return { id_token, access_token, refresh_token }
}

export async function currentSubscriptionTokens(opts?: {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  force?: boolean
}): Promise<OpenaiStoredTokens | undefined> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const tokens = readAuthFile()?.tokens
  if (!tokens?.refreshToken) return undefined
  const adoptable = (latest: OpenaiStoredTokens | undefined): boolean =>
    tokensFresh(latest, now()) && (!opts?.force || latest?.accessToken !== tokens.accessToken)
  if (adoptable(tokens)) return tokens
  if (knownDeadRefreshTokens.has(tokens.refreshToken)) return undefined
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    const sleep = (ms: number): Promise<void> =>
      new Promise(resolve => {
        const t = setTimeout(resolve, ms)
        ;(t as { unref?: () => void }).unref?.()
      })
    let locked = false
    let usedRefreshToken: string | undefined
    try {
      locked = acquireRefreshLock(now())
      if (!locked) {
        const deadline = now() + REFRESH_WAIT_TOTAL_MS
        while (now() < deadline) {
          await sleep(REFRESH_WAIT_STEP_MS)
          const latest = readAuthFile()?.tokens
          if (adoptable(latest)) return latest
        }
      }
      const latest = readAuthFile()?.tokens
      if (adoptable(latest)) return latest
      const base = latest?.refreshToken ? latest : tokens
      if (knownDeadRefreshTokens.has(base.refreshToken)) return undefined
      usedRefreshToken = base.refreshToken
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: OPENAI_OAUTH_CLIENT_ID,
        refresh_token: base.refreshToken,
      })
      const raw = await postTokenEndpoint(body, opts?.fetchImpl ?? getApiFetch(), env)
      const next = tokensFromExchange({
        id_token: raw.id_token || base.idToken,
        access_token: raw.access_token,
        refresh_token: raw.refresh_token || base.refreshToken,
      })
      writeAuthFile(f => ({ ...f, tokens: next, lastRefreshMs: now() }))
      return next
    } catch (error) {
      const latest = readAuthFile()?.tokens
      if (
        latest?.refreshToken &&
        (tokensFresh(latest, now()) ||
          (usedRefreshToken !== undefined && latest.refreshToken !== usedRefreshToken))
      ) {
        return latest
      }
      if (usedRefreshToken !== undefined && isTerminalGrantRefusal(error)) {
        knownDeadRefreshTokens.add(usedRefreshToken)
        blankDeadRefreshTokenOnDisk(usedRefreshToken)
        return undefined
      }
      return latest?.refreshToken ? latest : tokens
    } finally {
      if (locked) releaseRefreshLock()
      refreshInFlight = undefined
    }
  })()
  return refreshInFlight
}

export function disconnectOpenaiSubscription(): void {
  writeAuthFile(file => {
    const next = { ...file }
    delete next.tokens
    delete next.lastRefreshMs
    if (next.preferredSource === 'chatgpt-subscription') delete next.preferredSource
    return next
  })
}


export interface OpenaiConnectHandles {
  authorizeUrl: string
  result: Promise<OpenaiAccountRef>
  completeWithRedirect(pasted: string): void
  cancel(reason?: string): void
  boundLoopbackPort(): number | undefined
}

function buildAuthorizeUrl(env: NodeJS.ProcessEnv, challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OPENAI_OAUTH_CLIENT_ID,
    redirect_uri: OPENAI_OAUTH_REDIRECT_URI,
    scope: OPENAI_OAUTH_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: 'mercury',
  })
  return `${openaiIssuerBase(env)}/oauth/authorize?${params.toString()}`
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<OpenaiStoredTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: OPENAI_OAUTH_REDIRECT_URI,
    client_id: OPENAI_OAUTH_CLIENT_ID,
    code_verifier: verifier,
  })
  const raw = await postTokenEndpoint(body, fetchImpl, env)
  return tokensFromExchange(raw)
}

export function beginOpenaiBrowserConnect(opts?: {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  skipBrowserOpen?: boolean
  onListenerIssue?: (message: string) => void
  onSettledAfterCancel?: (ref: OpenaiAccountRef) => void
  loopbackPort?: number
}): OpenaiConnectHandles {
  const env = opts?.env ?? process.env
  const requestedPort = opts?.loopbackPort ?? OPENAI_OAUTH_REDIRECT_PORT
  const verifier = generateCodeVerifier()
  const challenge = generateCodeChallenge(verifier)
  const state = generateState()
  const authorizeUrl = buildAuthorizeUrl(env, challenge, state)
  const fetchImpl = opts?.fetchImpl ?? getApiFetch()

  let settle!: (ref: OpenaiAccountRef) => void
  let fail!: (error: Error) => void
  const result = new Promise<OpenaiAccountRef>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  let server: Server | undefined
  let done = false
  let exchangeInFlight = false
  let cancelledMidExchange = false
  let settled = false
  const doSettle = (ref: OpenaiAccountRef): void => {
    if (settled) return
    settled = true
    settle(ref)
  }
  const doFail = (error: Error): void => {
    if (settled) return
    settled = true
    fail(error)
  }

  const finish = async (code: string): Promise<'settled' | 'disclosed' | 'failed' | 'ignored'> => {
    if (done) return 'ignored'
    done = true
    exchangeInFlight = true
    try {
      const tokens = await exchangeAuthorizationCode(code, verifier, fetchImpl, env)
      writeAuthFile(file => ({
        ...file,
        tokens,
        lastRefreshMs: Date.now(),
        preferredSource: 'chatgpt-subscription',
      }))
      recordSignIn('openai', 'subscription')
      const resolved = resolveOpenaiAccount(env)
      const ref: OpenaiAccountRef =
        resolved && resolved.kind === 'chatgpt-subscription'
          ? resolved
          : {
              provider: 'openai',
              kind: 'chatgpt-subscription',
              label: tokens.planType
                ? `ChatGPT ${tokens.planType} subscription`
                : 'ChatGPT subscription',
              ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
              ...(tokens.planType ? { planType: tokens.planType } : {}),
            }
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

  const extractCode = (pasted: string): { code?: string; state?: string } => {
    const trimmed = pasted.trim()
    try {
      const url = new URL(trimmed)
      return {
        code: url.searchParams.get('code') ?? undefined,
        state: url.searchParams.get('state') ?? undefined,
      }
    } catch {
      const [code, pastedState] = trimmed.split('#')
      return { code: code || undefined, state: pastedState || undefined }
    }
  }

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${requestedPort}`)
    if (url.pathname !== '/auth/callback') {
      res.writeHead(404).end()
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
          .end('Mercury: OpenAI account connected. You can close this tab.')
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
        .end('Mercury: the OpenAI sign-in could not complete — the terminal has the reason; retry from /logins.')
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

  return {
    authorizeUrl,
    result,
    completeWithRedirect(pasted: string): void {
      const extracted = extractCode(pasted)
      if (!extracted.code) {
        done = true
        server?.close()
        server = undefined
        doFail(new Error('no authorization code found in the pasted value'))
        return
      }
      if (extracted.state && extracted.state !== state) {
        done = true
        server?.close()
        server = undefined
        doFail(new Error('pasted state does not match this sign-in attempt'))
        return
      }
      void finish(extracted.code)
    },
    cancel(reason?: string): void {
      if (exchangeInFlight) cancelledMidExchange = true
      done = true
      server?.close()
      server = undefined
      doFail(new Error(reason ?? 'openai connect cancelled'))
    },
    boundLoopbackPort(): number | undefined {
      const address = server?.address()
      return typeof address === 'object' && address !== null ? address.port : undefined
    },
  }
}


export interface OpenaiDeviceConnectStart {
  userCode: string
  verifyHint: string
  result: Promise<OpenaiAccountRef>
}

export async function beginOpenaiDeviceConnect(opts?: {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  pollIntervalMsOverride?: number
  maxWaitMs?: number
}): Promise<OpenaiDeviceConnectStart> {
  const env = opts?.env ?? process.env
  const fetchImpl = opts?.fetchImpl ?? getApiFetch()
  const base = openaiIssuerBase(env)
  const startResponse = await fetchWithProviderDeadline(fetchImpl, 'openai', LOGIN_EXCHANGE_TIMEOUT_MS, `${base}/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': getUserAgent() },
    body: JSON.stringify({ client_id: OPENAI_OAUTH_CLIENT_ID }),
    ...(getProxyFetchOptions() as Record<string, unknown>),
  } as RequestInit)
  if (!startResponse.ok) {
    throw new Error(`openai device authorization unavailable (HTTP ${startResponse.status})`)
  }
  const started = (await startResponse.json()) as Record<string, unknown>
  const userCode = String(started.user_code ?? started.usercode ?? '')
  const deviceAuthId = String(started.device_auth_id ?? '')
  const intervalS = Number(started.interval ?? 5)
  if (!userCode) throw new Error('openai device authorization returned no user code')

  const result = (async (): Promise<OpenaiAccountRef> => {
    const deadline = Date.now() + (opts?.maxWaitMs ?? 15 * 60_000)
    const intervalMs = opts?.pollIntervalMsOverride ?? Math.max(1, intervalS) * 1000
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error('OpenAI sign-in expired before the code was approved — retry from /logins openai')
      }
      await new Promise(resolve => {
        const t = setTimeout(resolve, intervalMs)
        ;(t as { unref?: () => void }).unref?.()
      })
      const poll = await fetchWithProviderDeadline(fetchImpl, 'openai', LOGIN_EXCHANGE_TIMEOUT_MS, `${base}/deviceauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': getUserAgent() },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
        ...(getProxyFetchOptions() as Record<string, unknown>),
      } as RequestInit)
      if (poll.status === 404 || poll.status === 428 || poll.status === 425) continue
      if (!poll.ok) {
        let verdict: string | undefined
        try {
          const errorBody = (await poll.json()) as Record<string, unknown>
          if (typeof errorBody.error === 'string' && errorBody.error !== '') {
            verdict = errorBody.error
          }
        } catch {
        }
        if (verdict === 'access_denied' || verdict === 'expired_token' || poll.status === 403) {
          throw new Error(
            `openai device authorization denied (${verdict ?? `HTTP ${poll.status}`}) — the sign-in was refused; run the connect again to retry`,
          )
        }
        continue
      }
      const body = (await poll.json()) as Record<string, unknown>
      const code = typeof body.authorization_code === 'string' ? body.authorization_code : ''
      const verifier = typeof body.code_verifier === 'string' ? body.code_verifier : ''
      if (!code || !verifier) continue
      const exchange = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: OPENAI_OAUTH_REDIRECT_URI,
        client_id: OPENAI_OAUTH_CLIENT_ID,
        code_verifier: verifier,
      })
      const raw = await postTokenEndpoint(exchange, fetchImpl, env)
      const tokens = tokensFromExchange(raw)
      writeAuthFile(file => ({
        ...file,
        tokens,
        lastRefreshMs: Date.now(),
        preferredSource: 'chatgpt-subscription',
      }))
      recordSignIn('openai', 'subscription')
      const ref = resolveOpenaiAccount(env)
      if (ref?.kind === 'chatgpt-subscription') return ref
      return {
        provider: 'openai',
        kind: 'chatgpt-subscription',
        label: 'ChatGPT subscription',
        ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
      }
    }
  })()

  return {
    userCode,
    verifyHint: `${base} → sign in, then enter code ${userCode}`,
    result,
  }
}


export interface OpenaiRequestAuth {
  account: OpenaiAccountRef
  baseUrl: string
  headers: Record<string, string>
}

export async function resolveOpenaiRequestAuth(opts?: {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  sourceKind?: OpenaiAccountSourceKind
  forceRefresh?: boolean
}): Promise<OpenaiRequestAuth | undefined> {
  const env = opts?.env ?? process.env
  const account = resolveOpenaiAccount(env)
  const kind = opts?.sourceKind ?? account?.kind
  if (!kind) return undefined
  if (kind === 'api-key') {
    const key = resolveOpenaiApiKey(env)
    if (!key) return undefined
    return {
      account: {
        provider: 'openai',
        kind: 'api-key',
        label: `OpenAI API key (${key.source})`,
        keySource: key.source,
      },
      baseUrl: openaiApiBase(env),
      headers: { authorization: `Bearer ${key.key}` },
    }
  }
  const tokens = await currentSubscriptionTokens({
    ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    env,
    ...(opts?.forceRefresh ? { force: true } : {}),
  })
  if (!tokens?.accessToken) return undefined
  return {
    account: {
      provider: 'openai',
      kind: 'chatgpt-subscription',
      label: tokens.planType
        ? `ChatGPT ${tokens.planType} subscription`
        : 'ChatGPT subscription',
      ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
      ...(tokens.planType ? { planType: tokens.planType } : {}),
    },
    baseUrl: openaiChatgptBase(env),
    headers: {
      authorization: `Bearer ${tokens.accessToken}`,
      ...(tokens.accountId ? { 'ChatGPT-Account-Id': tokens.accountId } : {}),
    },
  }
}

export function __resetOpenaiAccountsForTest(): void {
  refreshInFlight = undefined
  knownDeadRefreshTokens.clear()
}
