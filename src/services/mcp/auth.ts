import {
  type AuthResult,
  discoverAuthorizationServerMetadata,
  discoverOAuthServerInfo,
  auth as sdkAuth,
  refreshAuthorization as sdkRefreshAuthorization,
  type OAuthClientProvider,
} from './sdk.js'
import {
  InvalidClientError,
  InvalidGrantError,
  OAuthError,
  ServerError,
  TemporarilyUnavailableError,
  TooManyRequestsError,
} from './sdk.js'
import {
  type AuthorizationServerMetadata,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  OAuthErrorResponseSchema,
  OAuthMetadataSchema,
  type OAuthTokens,
  OAuthTokensSchema,
} from './sdk.js'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'

import { MCP_CLIENT_METADATA_URL } from '../../constants/oauth.js'
import { openBrowser } from '../../utils/browser.js'
import { describeHeadersRedacted } from '../../utils/redactHeaders.js'
import { logForDebugging } from '../../utils/debug.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { lock } from '../../utils/lockfile.js'
import { clearKeychainCache, getSecureStorage } from '../../utils/secureStorage/index.js'
import { buildRedirectUri, findAvailablePort } from './oauthPort.js'
import type { McpServerConfig } from './types.js'
import { performCrossAppAccess, XaaTokenExchangeError } from './xaa.js'
import {
  acquireIdpIdToken,
  clearIdpIdToken,
  discoverOidc,
  getCachedIdpIdToken,
  getIdpClientSecret,
  getXaaIdpSettings,
  isXaaEnabled,
} from './xaaIdpLogin.js'

/**
 * The whole OAuth surface for remote MCP servers: discovery, the loopback
 * authorization-code flow, token storage/refresh/revocation, step-up scope,
 * and cross-app access.
 */

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

export class AuthenticationCancelledError extends Error {
  constructor(message = 'Authentication cancelled') {
    super(message)
    this.name = 'AuthenticationCancelledError'
  }
}

type RemoteServerConfig = McpServerConfig & {
  url?: string
  headers?: Record<string, string>
  oauth?: {
    clientId?: string
    callbackPort?: number
    authServerMetadataUrl?: string
    xaa?: boolean
  }
}

type StoredDiscoveryState = {
  authorizationServerUrl?: string
  resourceMetadataUrl?: string
  authorizationServerMetadata?: unknown
  resourceMetadata?: unknown
}

type StoredOAuthEntry = {
  serverName: string
  serverUrl: string
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scope?: string
  clientId?: string
  clientSecret?: string
  stepUpScope?: string
  discoveryState?: StoredDiscoveryState
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

const AUTH_FETCH_TIMEOUT_MS = 30_000
const FLOW_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_TOKEN_LIFETIME_S = 3600
const REFRESH_LEAD_S = 300
const REFRESH_ATTEMPTS = 3
const LOCK_ATTEMPTS = 5
const EXPIRING_SOON_MS = 30 * 60 * 1000
const CALLBACK_PATH = '/callback'
const REDACTED_QUERY_KEYS = ['state', 'nonce', 'code_challenge', 'code_verifier', 'code']

/** Stable failure-reason vocabulary (analytics-visible; additive only). */
type RefreshFailureReason =
  | 'metadata_discovery_failed'
  | 'no_client_info'
  | 'no_tokens_returned'
  | 'invalid_grant'
  | 'transient_retries_exhausted'
  | 'request_failed'
type FlowFailureReason =
  | 'cancelled'
  | 'timeout'
  | 'provider_denied'
  | 'state_mismatch'
  | 'port_unavailable'
  | 'sdk_auth_failed'
  | 'token_exchange_failed'
  | 'unknown'

/** The emitters are no-op stubs in this build; the vocabularies are preserved as values. */
function emitRefreshEvent(_outcome: 'success' | RefreshFailureReason): void {}
function emitFlowEvent(_outcome: 'success' | FlowFailureReason): void {}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

/** `<serverName>|<first 16 hex of sha256(type, url, headers)>`. */
export function getServerKey(serverName: string, serverConfig: McpServerConfig): string {
  const config = serverConfig as RemoteServerConfig
  const digest = createHash('sha256')
    .update(JSON.stringify({ type: config.type, url: config.url, headers: config.headers ?? {} }))
    .digest('hex')
    .slice(0, 16)
  return `${serverName}|${digest}`
}

function readEntry(serverKey: string): StoredOAuthEntry | undefined {
  const data = getSecureStorage().read()
  return (data?.mcpOAuth as Record<string, StoredOAuthEntry> | undefined)?.[serverKey]
}

async function readEntryAsync(serverKey: string): Promise<StoredOAuthEntry | undefined> {
  const data = await getSecureStorage().readAsync()
  return (data?.mcpOAuth as Record<string, StoredOAuthEntry> | undefined)?.[serverKey]
}

function writeEntry(serverKey: string, entry: StoredOAuthEntry | undefined): void {
  const storage = getSecureStorage()
  const data = storage.read() ?? {}
  const map = { ...((data.mcpOAuth as Record<string, StoredOAuthEntry> | undefined) ?? {}) }
  if (entry === undefined) delete map[serverKey]
  else map[serverKey] = entry
  storage.update({ ...data, mcpOAuth: map })
}

function newEntry(serverName: string, serverUrl: string): StoredOAuthEntry {
  return { serverName, serverUrl, accessToken: '', expiresAt: 0 }
}

function redactAuthUrl(url: string): string {
  try {
    const parsed = new URL(url)
    for (const key of REDACTED_QUERY_KEYS) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, '[REDACTED]')
    }
    return parsed.toString()
  } catch {
    return url
  }
}

/** Only the two URLs are persisted — never the metadata documents (the macOS credential store overflows). */
function stripDiscoveryState(state: StoredDiscoveryState | undefined): StoredDiscoveryState | undefined {
  if (state === undefined) return undefined
  const stripped: StoredDiscoveryState = {}
  if (state.authorizationServerUrl !== undefined) stripped.authorizationServerUrl = state.authorizationServerUrl
  if (state.resourceMetadataUrl !== undefined) stripped.resourceMetadataUrl = state.resourceMetadataUrl
  return stripped
}

// ---------------------------------------------------------------------------
// The auth fetch (fresh 30 s timeout per request) + error-body normalisation
// ---------------------------------------------------------------------------

const INVALID_GRANT_ALIASES = new Set(['invalid_refresh_token', 'expired_refresh_token', 'token_expired'])

/**
 * A 200 whose body is an OAuth error (but not a token response) is rebuilt as
 * a 400 carrying that error, keeping the headers. Every path re-materialises
 * the body — peeking consumes it. Non-standard invalid-grant aliases are
 * normalised to `invalid_grant`.
 */
export async function normalizeOAuthErrorBody(response: Response): Promise<Response> {
  if (!response.ok) return response
  const text = await response.text()
  const rebuild = (status: number, body: string): Response =>
    new Response(body, { status, statusText: status === 400 ? 'Bad Request' : response.statusText, headers: response.headers })
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return rebuild(response.status, text)
  }
  if (OAuthTokensSchema.safeParse(json).success) return rebuild(response.status, text)
  const asError = OAuthErrorResponseSchema.safeParse(json)
  if (!asError.success) return rebuild(response.status, text)
  const body = { ...(json as Record<string, unknown>) }
  const code = asError.data.error
  if (INVALID_GRANT_ALIASES.has(code)) {
    body.error = 'invalid_grant'
    if (body.error_description === undefined) {
      body.error_description = `Non-standard error code "${code}" normalised to invalid_grant`
    }
  }
  return rebuild(400, JSON.stringify(body))
}

function combineSignals(caller: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('OAuth request timed out', 'TimeoutError')), timeoutMs)
  timer.unref?.()
  const onAbort = (): void => controller.abort(caller?.reason)
  if (caller !== undefined) {
    if (caller.aborted) controller.abort(caller.reason)
    else caller.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer)
      caller?.removeEventListener('abort', onAbort)
    },
  }
}

const authFetch: FetchLike = async (input, init) => {
  const { signal, release } = combineSignals(init?.signal ?? undefined, AUTH_FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(input as string, { ...init, signal })
    if ((init?.method ?? 'GET').toUpperCase() === 'POST') return normalizeOAuthErrorBody(response)
    return response
  } finally {
    release()
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function fetchConfiguredMetadata(metadataUrl: string): Promise<AuthorizationServerMetadata> {
  if (!metadataUrl.startsWith('https://')) {
    throw new Error(`authServerMetadataUrl must use https:// (got ${metadataUrl})`)
  }
  const response = await authFetch(metadataUrl, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`Failed to fetch OAuth metadata: HTTP ${response.status} from ${metadataUrl}`)
  return OAuthMetadataSchema.parse(await response.json()) as AuthorizationServerMetadata
}

async function discoverMetadata(serverUrl: string, config: RemoteServerConfig): Promise<AuthorizationServerMetadata | undefined> {
  const configured = config.oauth?.authServerMetadataUrl
  if (configured) return fetchConfiguredMetadata(configured)
  try {
    const info = await discoverOAuthServerInfo(serverUrl, { fetchFn: authFetch as never })
    if (info.authorizationServerMetadata) return info.authorizationServerMetadata
  } catch (err) {
    logForDebugging(`mcp auth: RFC 9728/8414 discovery failed for ${serverUrl}: ${String(err)}`)
  }
  // Path-aware RFC 8414 fallback for legacy servers co-hosting metadata under the path.
  const url = new URL(serverUrl)
  if (url.pathname && url.pathname !== '/') {
    try {
      return await discoverAuthorizationServerMetadata(serverUrl, { fetchFn: authFetch as never })
    } catch (err) {
      logForDebugging(`mcp auth: path-aware fallback discovery failed for ${serverUrl}: ${String(err)}`)
    }
  }
  return undefined
}

function scopeFromMetadata(metadata: AuthorizationServerMetadata | undefined): string | undefined {
  if (!metadata) return undefined
  const record = metadata as Record<string, unknown>
  if (typeof record.scope === 'string') return record.scope
  if (typeof record.default_scope === 'string') return record.default_scope
  if (Array.isArray(record.scopes_supported)) return (record.scopes_supported as string[]).join(' ')
  return undefined
}

// ---------------------------------------------------------------------------
// The auth provider
// ---------------------------------------------------------------------------

/** One in-flight refresh/exchange per server key, shared by concurrent readers. */
const inFlightRefresh = new Map<string, Promise<OAuthTokens | undefined>>()
/** Same-session metadata cache for refreshes. */
const metadataCache = new Map<string, AuthorizationServerMetadata>()

export class MercuryMcpAuthProvider implements OAuthClientProvider {
  private readonly serverKey: string
  private readonly config: RemoteServerConfig
  private readonly stateValue: string
  private metadata: AuthorizationServerMetadata | undefined
  private verifier: string | undefined
  private lastAuthorizationUrl: string | undefined
  private readonly redirectUri: string

  constructor(
    private readonly serverName: string,
    serverConfig: McpServerConfig,
    redirectUri?: string,
    private readonly handleRedirection: boolean = false,
    private readonly onAuthorizationUrl?: (url: string) => void,
    private readonly skipBrowserOpen: boolean = false,
  ) {
    this.config = serverConfig as RemoteServerConfig
    this.serverKey = getServerKey(serverName, serverConfig)
    this.redirectUri = redirectUri ?? buildRedirectUri()
    this.stateValue = randomBytes(32).toString('base64url')
  }

  get redirectUrl(): string {
    return this.redirectUri
  }

  get authorizationUrl(): string | undefined {
    return this.lastAuthorizationUrl
  }

  get clientMetadataUrl(): string {
    const override = process.env.MCP_OAUTH_CLIENT_METADATA_URL
    if (override) {
      logForDebugging(`mcp auth [${this.serverName}]: client metadata URL from MCP_OAUTH_CLIENT_METADATA_URL`)
      return override
    }
    return MCP_CLIENT_METADATA_URL
  }

  get clientMetadata(): OAuthClientMetadata {
    const scope = scopeFromMetadata(this.metadata)
    if (scope) logForDebugging(`mcp auth [${this.serverName}]: client metadata scope ${scope}`)
    return {
      client_name: `Mercury (${this.serverName})`,
      redirect_uris: [this.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(scope ? { scope } : {}),
    }
  }

  setMetadata(metadata: AuthorizationServerMetadata | undefined): void {
    this.metadata = metadata
  }

  state(): string {
    return this.stateValue
  }

  private serverUrl(): string {
    return this.config.url ?? ''
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const entry = readEntry(this.serverKey)
    if (entry?.clientId) {
      logForDebugging(`mcp auth [${this.serverName}]: using stored client id`)
      return { client_id: entry.clientId, ...(entry.clientSecret ? { client_secret: entry.clientSecret } : {}) }
    }
    if (this.config.oauth?.clientId) {
      logForDebugging(`mcp auth [${this.serverName}]: using configured client id`)
      const secret = getMcpClientConfig(this.serverName, this.config)?.clientSecret
      return { client_id: this.config.oauth.clientId, ...(secret ? { client_secret: secret } : {}) }
    }
    logForDebugging(`mcp auth [${this.serverName}]: no client information (registration will run)`)
    return undefined
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    const entry = readEntry(this.serverKey) ?? newEntry(this.serverName, this.serverUrl())
    entry.clientId = info.client_id
    if ('client_secret' in info && info.client_secret) entry.clientSecret = info.client_secret
    writeEntry(this.serverKey, entry)
  }

  saveTokens(tokens: OAuthTokens): void {
    const entry = readEntry(this.serverKey) ?? newEntry(this.serverName, this.serverUrl())
    delete entry.stepUpScope
    entry.accessToken = tokens.access_token
    entry.refreshToken = tokens.refresh_token
    entry.expiresAt = Date.now() + (tokens.expires_in ?? DEFAULT_TOKEN_LIFETIME_S) * 1000
    entry.scope = tokens.scope
    writeEntry(this.serverKey, entry)
  }

  private stepUpPending(entry: StoredOAuthEntry): boolean {
    if (!entry.stepUpScope) return false
    const current = new Set((entry.scope ?? '').split(' ').filter(Boolean))
    return entry.stepUpScope.split(' ').filter(Boolean).some(scope => !current.has(scope))
  }

  private xaaConfigured(): boolean {
    return isXaaEnabled() && this.config.oauth?.xaa === true
  }

  /** The hot path — called by the SDK on every request; never forces a keychain miss. */
  async tokens(): Promise<OAuthTokens | undefined> {
    const entry = await readEntryAsync(this.serverKey)
    const nearExpiry = (record: StoredOAuthEntry): boolean =>
      !record.accessToken || record.expiresAt - Date.now() < REFRESH_LEAD_S * 1000
    if (this.xaaConfigured() && !entry?.refreshToken && (entry === undefined || nearExpiry(entry))) {
      const exchanged = await this.dedupe(() => this.silentCrossAppRefresh())
      if (exchanged !== undefined) return exchanged
    }
    if (entry === undefined) {
      logForDebugging(`mcp auth [${this.serverName}]: no stored tokens`)
      return undefined
    }
    const pending = this.stepUpPending(entry)
    const remainingS = Math.floor((entry.expiresAt - Date.now()) / 1000)
    if (remainingS <= 0 && !entry.refreshToken) return undefined
    if (remainingS < REFRESH_LEAD_S && entry.refreshToken && !pending) {
      const refreshed = await this.dedupe(() => this.refreshAuthorization(entry.refreshToken as string))
      if (refreshed !== undefined) return refreshed
    }
    logForDebugging(
      `mcp auth [${this.serverName}]: token length ${entry.accessToken.length}, refresh ${entry.refreshToken ? 'present' : 'absent'}, ${remainingS}s remaining`,
    )
    return {
      access_token: entry.accessToken,
      // Omitted under step-up: RFC 6749 §6 forbids scope elevation via refresh.
      ...(pending || !entry.refreshToken ? {} : { refresh_token: entry.refreshToken }),
      expires_in: remainingS,
      scope: entry.scope,
      token_type: 'bearer',
    }
  }

  private dedupe(work: () => Promise<OAuthTokens | undefined>): Promise<OAuthTokens | undefined> {
    const existing = inFlightRefresh.get(this.serverKey)
    if (existing !== undefined) {
      logForDebugging(`mcp auth [${this.serverName}]: reusing in-flight refresh`)
      return existing
    }
    const promise = work()
      .catch(err => {
        logForDebugging(`mcp auth [${this.serverName}]: refresh threw: ${String(err)}`)
        return undefined
      })
      .finally(() => {
        inFlightRefresh.delete(this.serverKey)
      })
    inFlightRefresh.set(this.serverKey, promise)
    return promise
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const url = authorizationUrl.toString()
    this.lastAuthorizationUrl = url
    const fromQuery = authorizationUrl.searchParams.get('scope') ?? undefined
    const scope = fromQuery ?? scopeFromMetadata(this.metadata)
    logForDebugging(
      `mcp auth [${this.serverName}]: authorization URL ${redactAuthUrl(url)} (scope ${fromQuery ? 'from URL' : scope ? 'from metadata' : 'unavailable'})`,
    )
    // Only the TRANSPORT-ATTACHED provider persists the step-up scope.
    if (scope && !this.handleRedirection) {
      const entry = readEntry(this.serverKey)
      if (entry) {
        entry.stepUpScope = scope
        writeEntry(this.serverKey, entry)
      }
    }
    if (!this.handleRedirection) return
    if (authorizationUrl.protocol !== 'http:' && authorizationUrl.protocol !== 'https:') {
      throw new Error(`Refusing to open authorization URL with scheme ${authorizationUrl.protocol}`)
    }
    // The UI gets the URL BEFORE the browser opens (a fallback if it fails).
    this.onAuthorizationUrl?.(url)
    if (!this.skipBrowserOpen) {
      const opened = await openBrowser(url).catch(() => false)
      if (!opened) logForDebugging(`mcp auth [${this.serverName}]: browser open failed; URL is shown in UI`)
    }
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier
  }

  codeVerifier(): string {
    if (this.verifier === undefined) throw new Error('No code verifier saved')
    return this.verifier
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'verifier') {
      this.verifier = undefined
      return
    }
    const entry = readEntry(this.serverKey)
    if (scope === 'all') {
      writeEntry(this.serverKey, undefined)
    } else if (entry !== undefined) {
      if (scope === 'client') {
        delete entry.clientId
        delete entry.clientSecret
      } else if (scope === 'tokens') {
        entry.accessToken = ''
        delete entry.refreshToken
        entry.expiresAt = 0
      } else {
        delete entry.discoveryState
        delete entry.stepUpScope
      }
      writeEntry(this.serverKey, entry)
    }
    logForDebugging(`mcp auth [${this.serverName}]: invalidated credentials (${scope})`)
  }

  saveDiscoveryState(state: { authorizationServerUrl?: string; resourceMetadataUrl?: string }): void {
    const entry = readEntry(this.serverKey) ?? newEntry(this.serverName, this.serverUrl())
    entry.discoveryState = stripDiscoveryState(state)
    writeEntry(this.serverKey, entry)
  }

  async discoveryState(): Promise<
    | { authorizationServerUrl: string; resourceMetadataUrl?: string; authorizationServerMetadata?: AuthorizationServerMetadata }
    | undefined
  > {
    const entry = readEntry(this.serverKey)
    const cached = entry?.discoveryState
    if (cached?.authorizationServerUrl) {
      return {
        authorizationServerUrl: cached.authorizationServerUrl,
        ...(cached.resourceMetadataUrl ? { resourceMetadataUrl: cached.resourceMetadataUrl } : {}),
        ...(cached.authorizationServerMetadata
          ? { authorizationServerMetadata: cached.authorizationServerMetadata as AuthorizationServerMetadata }
          : {}),
      }
    }
    const configured = this.config.oauth?.authServerMetadataUrl
    if (configured) {
      try {
        const metadata = await fetchConfiguredMetadata(configured)
        return { authorizationServerUrl: metadata.issuer, authorizationServerMetadata: metadata }
      } catch (err) {
        logForDebugging(`mcp auth [${this.serverName}]: configured metadata fetch failed: ${String(err)}`)
      }
    }
    return undefined
  }

  markStepUpPending(scope: string): void {
    const entry = readEntry(this.serverKey) ?? newEntry(this.serverName, this.serverUrl())
    entry.stepUpScope = scope
    writeEntry(this.serverKey, entry)
  }

  private async resolveMetadataForRefresh(): Promise<AuthorizationServerMetadata | undefined> {
    const cached = metadataCache.get(this.serverKey)
    if (cached) return cached
    const entry = readEntry(this.serverKey)
    const persisted = entry?.discoveryState?.authorizationServerMetadata as AuthorizationServerMetadata | undefined
    if (persisted) return persisted
    const authServerUrl = entry?.discoveryState?.authorizationServerUrl
    if (authServerUrl) {
      try {
        const rediscovered = await discoverAuthorizationServerMetadata(authServerUrl, { fetchFn: authFetch as never })
        if (rediscovered) return rediscovered
      } catch (err) {
        logForDebugging(`mcp auth [${this.serverName}]: re-discovery from persisted URL failed: ${String(err)}`)
      }
    }
    return discoverMetadata(this.serverUrl(), this.config)
  }

  private async withRefreshLock<T>(work: () => Promise<T>): Promise<T> {
    const home = getMercuryHome()
    if (!existsSync(home)) mkdirSync(home, { recursive: true })
    const lockPath = join(home, `mcp-refresh-${this.serverKey.replace(/[^a-zA-Z0-9]/g, '_')}.lock`)
    let release: (() => Promise<void>) | undefined
    for (let attempt = 0; attempt < LOCK_ATTEMPTS && release === undefined; attempt++) {
      try {
        release = await lock(lockPath, { realpath: false })
      } catch (err) {
        if ((err as { code?: string }).code === 'ELOCKED') {
          await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000))
          continue
        }
        logForDebugging(`mcp auth [${this.serverName}]: refresh lock error, proceeding without lock: ${String(err)}`)
        break
      }
    }
    try {
      return await work()
    } finally {
      if (release !== undefined) {
        await release().catch(err => logForDebugging(`mcp auth [${this.serverName}]: lock release failed: ${String(err)}`))
      }
    }
  }

  private freshStoredTokens(): OAuthTokens | undefined {
    clearKeychainCache()
    const entry = readEntry(this.serverKey)
    if (entry && entry.accessToken && entry.expiresAt - Date.now() > REFRESH_LEAD_S * 1000) {
      return {
        access_token: entry.accessToken,
        refresh_token: entry.refreshToken,
        expires_in: Math.floor((entry.expiresAt - Date.now()) / 1000),
        scope: entry.scope,
        token_type: 'bearer',
      }
    }
    return undefined
  }

  /** Cross-process locked; up to three attempts (two sleeps: 1 s then 2 s). */
  async refreshAuthorization(refreshToken: string): Promise<OAuthTokens | undefined> {
    return this.withRefreshLock(async () => {
      // Another process may have refreshed while we waited.
      const fresh = this.freshStoredTokens()
      if (fresh !== undefined) return fresh
      const stored = readEntry(this.serverKey)
      const tokenToUse = stored?.refreshToken ?? refreshToken

      const metadata = await this.resolveMetadataForRefresh()
      if (metadata === undefined) {
        emitRefreshEvent('metadata_discovery_failed')
        return undefined
      }
      metadataCache.set(this.serverKey, metadata)
      const clientInformation = this.clientInformation()
      if (clientInformation === undefined) {
        emitRefreshEvent('no_client_info')
        return undefined
      }
      let lastRetryable = false
      for (let attempt = 1; attempt <= REFRESH_ATTEMPTS; attempt++) {
        try {
          const tokens = await sdkRefreshAuthorization(this.serverUrl(), {
            metadata,
            clientInformation,
            refreshToken: tokenToUse,
            resource: new URL(this.serverUrl()),
            fetchFn: authFetch as never,
          })
          if (!tokens) {
            emitRefreshEvent('no_tokens_returned')
            return undefined
          }
          this.saveTokens(tokens)
          emitRefreshEvent('success')
          return tokens
        } catch (err) {
          if (err instanceof InvalidGrantError) {
            // The refresh token is dead — unless another process refreshed.
            const winner = this.freshStoredTokens()
            if (winner !== undefined) return winner
            this.invalidateCredentials('tokens')
            emitRefreshEvent('invalid_grant')
            return undefined
          }
          const message = err instanceof Error ? err.message : String(err)
          const retryable =
            /timeout|timed out|ETIMEDOUT|ECONNRESET/i.test(message) ||
            err instanceof ServerError ||
            err instanceof TemporarilyUnavailableError ||
            err instanceof TooManyRequestsError
          lastRetryable = retryable
          if (!retryable || attempt === REFRESH_ATTEMPTS) break
          await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** (attempt - 1)))
        }
      }
      emitRefreshEvent(lastRetryable ? 'transient_retries_exhausted' : 'request_failed')
      return undefined
    })
  }

  /** Silent cross-app refresh: soft-fails to nothing in four cases; only an exchange failure propagates. */
  private async silentCrossAppRefresh(): Promise<OAuthTokens | undefined> {
    const idp = getXaaIdpSettings()
    if (idp === undefined) {
      logForDebugging(`mcp auth [${this.serverName}]: xaa configured but IdP settings removed`)
      return undefined
    }
    const idToken = getCachedIdpIdToken(idp.issuer)
    if (idToken === undefined) {
      logForDebugging(`mcp auth [${this.serverName}]: xaa identity token not cached`)
      return undefined
    }
    const clientId = this.config.oauth?.clientId
    const clientSecret = getMcpClientConfig(this.serverName, this.config)?.clientSecret
    if (!clientId || !clientSecret) {
      logForDebugging(`mcp auth [${this.serverName}]: xaa server is missing its client id or secret`)
      return undefined
    }
    let oidc: Awaited<ReturnType<typeof discoverOidc>>
    try {
      oidc = await discoverOidc(idp.issuer)
    } catch (err) {
      logForDebugging(`mcp auth [${this.serverName}]: xaa OIDC discovery failed: ${String(err)}`)
      return undefined
    }
    try {
      const result = await performCrossAppAccess(
        this.serverUrl(),
        {
          clientId,
          clientSecret,
          idpClientId: idp.clientId,
          idpClientSecret: getIdpClientSecret(idp.issuer),
          idpIdToken: idToken,
          idpTokenEndpoint: (oidc as { token_endpoint: string }).token_endpoint,
        } as never,
        this.serverName,
      )
      writeXaaTokens(this.serverKey, this.serverName, this.serverUrl(), result, clientId, clientSecret)
      return {
        access_token: result.access_token,
        refresh_token: result.refresh_token,
        expires_in: result.expires_in ?? DEFAULT_TOKEN_LIFETIME_S,
        scope: result.scope,
        token_type: 'bearer',
      }
    } catch (err) {
      if (err instanceof XaaTokenExchangeError && err.shouldClearIdToken) clearIdpIdToken(idp.issuer)
      throw err
    }
  }
}

type XaaResultLike = {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  authorizationServerUrl: string
}

/** Written DIRECTLY into the normal slot (not through the provider's merging save path). */
function writeXaaTokens(
  serverKey: string,
  serverName: string,
  serverUrl: string,
  result: XaaResultLike,
  clientId: string,
  clientSecret: string,
): void {
  const previous = readEntry(serverKey)
  writeEntry(serverKey, {
    serverName,
    serverUrl,
    accessToken: result.access_token,
    refreshToken: result.refresh_token ?? previous?.refreshToken,
    expiresAt: Date.now() + (result.expires_in ?? DEFAULT_TOKEN_LIFETIME_S) * 1000,
    scope: result.scope,
    clientId,
    clientSecret,
    discoveryState: { authorizationServerUrl: result.authorizationServerUrl },
  })
}

// ---------------------------------------------------------------------------
// Step-up detection wrapper (must wrap INNERMOST)
// ---------------------------------------------------------------------------

export function wrapFetchWithStepUpDetection(baseFetch: FetchLike, provider: MercuryMcpAuthProvider): FetchLike {
  return async (input, init) => {
    const response = await baseFetch(input, init)
    if (response.status === 403) {
      const header = response.headers.get('www-authenticate') ?? ''
      if (header.includes('insufficient_scope')) {
        const match = /scope=(?:"([^"]+)"|([^\s,]+))/.exec(header)
        const scope = match?.[1] ?? match?.[2]
        if (scope) provider.markStepUpPending(scope)
      }
    }
    return response
  }
}

// ---------------------------------------------------------------------------
// The interactive authorization-code flow
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function classifyFlowFailure(err: unknown, codeObtained: boolean): FlowFailureReason {
  if (err instanceof AuthenticationCancelledError) return 'cancelled'
  if (codeObtained) return 'token_exchange_failed'
  const message = err instanceof Error ? err.message : String(err)
  if (/timed out|timeout/i.test(message)) return 'timeout'
  if (/state/i.test(message) && /mismatch|invalid/i.test(message)) return 'state_mismatch'
  if (/denied|access_denied/i.test(message)) return 'provider_denied'
  if (/already in use|callback server|available port/i.test(message)) return 'port_unavailable'
  if (err instanceof OAuthError) return 'sdk_auth_failed'
  return 'unknown'
}

export async function performMCPOAuthFlow(
  serverName: string,
  serverConfig: McpServerConfig,
  onAuthorizationUrl: (url: string) => void,
  abortSignal?: AbortSignal,
  opts?: { skipBrowserOpen?: boolean; onWaitingForCallback?: (submit: (pastedUrl: string) => void) => void },
): Promise<void> {
  const config = serverConfig as RemoteServerConfig
  const serverUrl = config.url ?? ''
  const serverKey = getServerKey(serverName, serverConfig)

  // Cross-app access is exclusive when configured — no silent fallback.
  if (config.oauth?.xaa === true) {
    if (!isXaaEnabled()) {
      throw new Error(
        `Server ${serverName} is configured for cross-app access, which is not available. Remove the per-server xaa flag to use the standard consent flow.`,
      )
    }
    await performInteractiveCrossAppAccess(serverName, config, serverKey, serverUrl, onAuthorizationUrl, abortSignal, opts)
    return
  }

  // Remember the cached step-up scope and resource-metadata URL BEFORE clearing.
  const previous = readEntry(serverKey)
  const stepUpScope = previous?.stepUpScope
  let resourceMetadataUrl: URL | undefined
  if (previous?.discoveryState?.resourceMetadataUrl) {
    try {
      resourceMetadataUrl = new URL(previous.discoveryState.resourceMetadataUrl)
    } catch {
      logForDebugging(`mcp auth [${serverName}]: ignoring unparseable cached resource metadata URL`)
    }
  }
  writeEntry(serverKey, undefined)

  const configuredPort = config.oauth?.callbackPort
  const port = configuredPort ?? (await findAvailablePort())
  const redirectUri = buildRedirectUri(port)
  logForDebugging(`mcp auth [${serverName}]: callback port ${port} (${configuredPort ? 'configured' : 'discovered'})`)

  const provider = new MercuryMcpAuthProvider(serverName, serverConfig, redirectUri, true, onAuthorizationUrl, opts?.skipBrowserOpen)
  try {
    const metadata = await discoverMetadata(serverUrl, config)
    provider.setMetadata(metadata)
  } catch (err) {
    logForDebugging(`mcp auth [${serverName}]: metadata discovery failed (continuing): ${String(err)}`)
  }
  const expectedState = provider.state()

  let codeObtained = false
  let server: Server | undefined
  let timeout: NodeJS.Timeout | undefined
  let settled = false
  let onAbort: (() => void) | undefined

  const cleanup = (): void => {
    if (server) {
      server.removeAllListeners()
      // Removing all listeners stripped the real error handler.
      server.on('error', () => {})
      server.close()
      server = undefined
    }
    if (timeout) clearTimeout(timeout)
    if (onAbort && abortSignal) abortSignal.removeEventListener('abort', onAbort)
  }

  const code = await new Promise<string>((resolve, reject) => {
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }
    onAbort = (): void => settle(() => {
      cleanup()
      reject(new AuthenticationCancelledError())
    })
    if (abortSignal?.aborted) {
      onAbort()
      return
    }
    abortSignal?.addEventListener('abort', onAbort, { once: true })

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      // Any other path is ignored entirely — no status, no body.
      if (url.pathname !== CALLBACK_PATH) return
      const error = url.searchParams.get('error')
      const state = url.searchParams.get('state')
      // State is validated FIRST on a non-error callback.
      if (!error && state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<html><body><h1>Sign-in state mismatch</h1><p>Close this window and retry from Mercury.</p></body></html>')
        settle(() => {
          cleanup()
          reject(new Error('OAuth state mismatch (possible CSRF) — retry the sign-in'))
        })
        return
      }
      if (error) {
        const description = url.searchParams.get('error_description')
        const errorUri = url.searchParams.get('error_uri')
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          `<html><body><h1>Authentication error: ${escapeHtml(error)}</h1><p>${escapeHtml(description ?? '')}</p><p>You can close this window.</p></body></html>`,
        )
        settle(() => {
          cleanup()
          reject(
            new Error(
              `OAuth error: ${error}${description ? ` — ${description}` : ''}${errorUri ? ` (${errorUri})` : ''}`,
            ),
          )
        })
        return
      }
      const received = url.searchParams.get('code')
      if (!received) return
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body><h1>Authentication successful</h1><p>You can close this window and return to Mercury.</p></body></html>')
      settle(() => {
        cleanup()
        codeObtained = true
        resolve(received)
      })
    })
    server.on('error', (err: NodeJS.ErrnoException) => {
      settle(() => {
        cleanup()
        if (err.code === 'EADDRINUSE') {
          const command =
            process.platform === 'win32' ? `netstat -ano | findstr :${port}` : `lsof -ti:${port} -sTCP:LISTEN`
          reject(
            new Error(
              `Port ${port} is already in use — another process may be holding it. Find it with: ${command}`,
            ),
          )
        } else {
          reject(new Error(`OAuth callback server failed: ${err.message}`))
        }
      })
    })
    server.listen(port, '127.0.0.1')
    server.unref()
    timeout = setTimeout(() => settle(() => {
      cleanup()
      reject(new Error('Authentication timed out'))
    }), FLOW_TIMEOUT_MS)
    timeout.unref()

    // Manual callback paste for environments where the browser cannot reach loopback.
    opts?.onWaitingForCallback?.((pasted: string) => {
      let parsed: URL
      try {
        parsed = new URL(pasted)
      } catch {
        return
      }
      const error = parsed.searchParams.get('error')
      if (error) {
        settle(() => {
          cleanup()
          reject(new Error(`OAuth error: ${error}`))
        })
        return
      }
      const received = parsed.searchParams.get('code')
      if (!received) return
      if (parsed.searchParams.get('state') !== expectedState) {
        settle(() => {
          cleanup()
          reject(new Error('OAuth state mismatch on pasted callback'))
        })
        return
      }
      settle(() => {
        cleanup()
        codeObtained = true
        resolve(received)
      })
    })

    void (async () => {
      try {
        const outcome: AuthResult = await sdkAuth(provider, {
          serverUrl,
          ...(stepUpScope ? { scope: stepUpScope } : {}),
          ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
          fetchFn: authFetch as never,
        })
        if (outcome !== 'REDIRECT') logForDebugging(`mcp auth [${serverName}]: unexpected pre-code auth outcome ${outcome}`)
      } catch (err) {
        settle(() => {
          cleanup()
          reject(new Error(`OAuth authorization failed: ${err instanceof Error ? err.message : String(err)}`))
        })
      }
    })()
  }).catch(err => {
    const reason = classifyFlowFailure(err, codeObtained)
    emitFlowEvent(reason)
    if (err instanceof InvalidClientError || /invalid_client/i.test(String(err))) {
      provider.invalidateCredentials('client')
    }
    throw err
  })

  try {
    const outcome = await sdkAuth(provider, {
      serverUrl,
      authorizationCode: code,
      ...(stepUpScope ? { scope: stepUpScope } : {}),
      ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
      fetchFn: authFetch as never,
    })
    if (outcome !== 'AUTHORIZED') throw new Error(`Unexpected OAuth outcome: ${outcome}`)
    const saved = readEntry(serverKey)
    logForDebugging(
      `mcp auth [${serverName}]: authorized (tokens ${saved?.accessToken ? `saved, length ${saved.accessToken.length}, expires ${new Date(saved.expiresAt).toISOString()}` : 'not saved'})`,
    )
    emitFlowEvent('success')
  } catch (err) {
    const reason = classifyFlowFailure(err, true)
    emitFlowEvent(reason)
    if (err instanceof OAuthError) {
      const status = /^HTTP (\d+):/.exec(err.message)?.[1]
      logForDebugging(`mcp auth [${serverName}]: OAuth error ${err.errorCode}${status ? ` (HTTP ${status})` : ''}`)
    }
    if (err instanceof InvalidClientError || /invalid_client/i.test(String(err))) {
      provider.invalidateCredentials('client')
    }
    throw err
  }
}

async function performInteractiveCrossAppAccess(
  serverName: string,
  config: RemoteServerConfig,
  serverKey: string,
  serverUrl: string,
  onAuthorizationUrl: (url: string) => void,
  abortSignal: AbortSignal | undefined,
  opts: { skipBrowserOpen?: boolean } | undefined,
): Promise<void> {
  const idp = getXaaIdpSettings()
  if (idp === undefined) {
    throw new Error('Cross-app access requires identity-provider settings. Configure them with: mercury mcp xaa setup')
  }
  const clientId = config.oauth?.clientId
  if (!clientId) {
    throw new Error(`Server ${serverName} has no authorization-server client id. Re-add it with --client-id.`)
  }
  const clientSecret = getMcpClientConfig(serverName, config)?.clientSecret
  if (!clientSecret) {
    const stored = getSecureStorage().read()
    const keys = Object.keys((stored?.mcpOAuthClientConfig as Record<string, unknown> | undefined) ?? {})
    logForDebugging(
      `mcp auth [${serverName}]: xaa client secret missing — wanted ${serverKey}, present ${keys.join(', ') || 'none'}, headers ${describeHeadersRedacted(config.headers)}`,
    )
    throw new Error(`Server ${serverName} has no authorization-server client secret. Re-add it with --client-secret.`)
  }
  const cachedBefore = getCachedIdpIdToken(idp.issuer) !== undefined
  void cachedBefore
  let stage: 'idp_login' | 'discovery' | 'token_exchange' | 'jwt_bearer' = 'idp_login'
  try {
    const idToken = await acquireIdpIdToken({
      idpIssuer: idp.issuer,
      idpClientId: idp.clientId,
      idpClientSecret: getIdpClientSecret(idp.issuer),
      callbackPort: idp.callbackPort,
      onAuthorizationUrl,
      skipBrowserOpen: opts?.skipBrowserOpen,
      abortSignal,
    } as never)
    stage = 'discovery'
    const oidc = await discoverOidc(idp.issuer)
    stage = 'token_exchange'
    const result = await performCrossAppAccess(
      serverUrl,
      {
        clientId,
        clientSecret,
        idpClientId: idp.clientId,
        idpClientSecret: getIdpClientSecret(idp.issuer),
        idpIdToken: idToken,
        idpTokenEndpoint: (oidc as { token_endpoint: string }).token_endpoint,
      } as never,
      serverName,
      abortSignal,
    )
    writeXaaTokens(serverKey, serverName, serverUrl, result, clientId, clientSecret)
    emitFlowEvent('success')
  } catch (err) {
    if (abortSignal?.aborted) throw new AuthenticationCancelledError()
    if (err instanceof XaaTokenExchangeError) {
      if (err.shouldClearIdToken) clearIdpIdToken(idp.issuer)
    } else if (err instanceof Error) {
      // Untyped errors: re-attribute discovery / bearer-grant failures.
      if (/protected resource|authorization server metadata|no authorization server/i.test(err.message)) stage = 'discovery'
      else if (/jwt-bearer|bearer grant/i.test(err.message)) stage = 'jwt_bearer'
    }
    logForDebugging(`mcp auth [${serverName}]: cross-app access failed at ${stage}: ${String(err)}`)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Revocation and clearing
// ---------------------------------------------------------------------------

async function revokeOne(
  endpoint: string,
  token: string,
  hint: 'refresh_token' | 'access_token',
  method: 'client_secret_basic' | 'client_secret_post',
  clientId: string | undefined,
  clientSecret: string | undefined,
  accessToken: string | undefined,
): Promise<void> {
  const body = new URLSearchParams({ token, token_type_hint: hint })
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (clientId && clientSecret) {
    if (method === 'client_secret_basic') {
      headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
    } else {
      body.set('client_id', clientId)
      body.set('client_secret', clientSecret)
    }
  } else if (clientId) {
    body.set('client_id', clientId)
  } else {
    logForDebugging('mcp auth: revoking without client authentication; the server may reject it')
  }
  let response = await authFetch(endpoint, { method: 'POST', headers, body: body.toString() })
  if (response.status === 401 && accessToken) {
    // Bearer retry for non-compliant servers — ONE auth method (RFC 6749 §2.3.1).
    body.delete('client_id')
    body.delete('client_secret')
    delete headers.Authorization
    response = await authFetch(endpoint, {
      method: 'POST',
      headers: { ...headers, Authorization: `Bearer ${accessToken}` },
      body: body.toString(),
    })
  }
  if (!response.ok) logForDebugging(`mcp auth: revocation of ${hint} answered HTTP ${response.status}`)
}

/** Best-effort RFC 7009 revocation, refresh token first; local clearing always follows. */
export async function revokeServerTokens(
  serverName: string,
  serverConfig: McpServerConfig,
  opts?: { preserveStepUpState?: boolean },
): Promise<void> {
  const serverKey = getServerKey(serverName, serverConfig)
  const entry = readEntry(serverKey)
  if (entry && (entry.accessToken || entry.refreshToken)) {
    try {
      const authServerUrl = entry.discoveryState?.authorizationServerUrl ?? (serverConfig as RemoteServerConfig).url ?? ''
      const metadata = await discoverAuthorizationServerMetadata(authServerUrl, { fetchFn: authFetch as never }).catch(
        () => undefined,
      )
      const record = metadata as Record<string, unknown> | undefined
      const endpoint = record?.revocation_endpoint as string | undefined
      if (!metadata || !endpoint) {
        logForDebugging(`mcp auth [${serverName}]: no revocation endpoint; skipping revocation`)
      } else {
        const supported =
          (record?.revocation_endpoint_auth_methods_supported as string[] | undefined) ??
          (record?.token_endpoint_auth_methods_supported as string[] | undefined) ??
          []
        const method =
          !supported.includes('client_secret_basic') && supported.includes('client_secret_post')
            ? 'client_secret_post'
            : 'client_secret_basic'
        if (entry.refreshToken) {
          await revokeOne(endpoint, entry.refreshToken, 'refresh_token', method, entry.clientId, entry.clientSecret, entry.accessToken).catch(
            err => logForDebugging(`mcp auth [${serverName}]: refresh-token revocation failed: ${String(err)}`),
          )
        }
        if (entry.accessToken) {
          await revokeOne(endpoint, entry.accessToken, 'access_token', method, entry.clientId, entry.clientSecret, entry.accessToken).catch(
            err => logForDebugging(`mcp auth [${serverName}]: access-token revocation failed: ${String(err)}`),
          )
        }
      }
    } catch (err) {
      logForDebugging(`mcp auth [${serverName}]: revocation lookup failed: ${String(err)}`)
    }
  } else {
    logForDebugging(`mcp auth [${serverName}]: nothing to revoke`)
  }
  if (opts?.preserveStepUpState && entry) {
    const fresh = newEntry(serverName, entry.serverUrl)
    if (entry.stepUpScope) fresh.stepUpScope = entry.stepUpScope
    const stripped = stripDiscoveryState(entry.discoveryState)
    if (stripped) fresh.discoveryState = stripped
    writeEntry(serverKey, fresh)
  } else {
    writeEntry(serverKey, undefined)
  }
}

export function clearServerTokensFromLocalStorage(serverName: string, serverConfig: McpServerConfig): void {
  const serverKey = getServerKey(serverName, serverConfig)
  if (readEntry(serverKey) !== undefined) writeEntry(serverKey, undefined)
}

/** Discovery exists but no token; cross-app-access servers are exempt (checked before storage is read). */
export function hasMcpDiscoveryButNoToken(serverName: string, serverConfig: McpServerConfig): boolean {
  if (isXaaEnabled() && (serverConfig as RemoteServerConfig).oauth?.xaa === true) return false
  const entry = readEntry(getServerKey(serverName, serverConfig))
  return entry !== undefined && !entry.accessToken && !entry.refreshToken
}

// ---------------------------------------------------------------------------
// Client-secret helpers
// ---------------------------------------------------------------------------

export async function readClientSecret(): Promise<string> {
  const fromEnv = process.env.MCP_CLIENT_SECRET
  if (fromEnv) return fromEnv
  if (!process.stdin.isTTY) {
    throw new Error('No TTY available to prompt for the client secret; set MCP_CLIENT_SECRET.')
  }
  process.stderr.write('Client secret: ')
  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin
    let secret = ''
    const finish = (): void => {
      stdin.setRawMode(false)
      stdin.removeListener('data', onData)
      stdin.pause()
      process.stderr.write('\n')
    }
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 0x0d || byte === 0x0a) {
          finish()
          resolve(secret)
          return
        }
        if (byte === 0x03) {
          finish()
          reject(new AuthenticationCancelledError('Client secret entry cancelled'))
          return
        }
        if (byte === 0x7f || byte === 0x08) {
          secret = secret.slice(0, -1)
          continue
        }
        secret += String.fromCharCode(byte)
      }
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}

export function saveMcpClientSecret(serverName: string, serverConfig: McpServerConfig, clientSecret: string): void {
  const storage = getSecureStorage()
  const data = storage.read() ?? {}
  const map = { ...((data.mcpOAuthClientConfig as Record<string, { clientSecret?: string }> | undefined) ?? {}) }
  map[getServerKey(serverName, serverConfig)] = { clientSecret }
  storage.update({ ...data, mcpOAuthClientConfig: map })
}

export function clearMcpClientConfig(serverName: string, serverConfig: McpServerConfig): void {
  const storage = getSecureStorage()
  const data = storage.read() ?? {}
  const map = { ...((data.mcpOAuthClientConfig as Record<string, unknown> | undefined) ?? {}) }
  const key = getServerKey(serverName, serverConfig)
  if (!(key in map)) return
  delete map[key]
  storage.update({ ...data, mcpOAuthClientConfig: map })
}

export function getMcpClientConfig(serverName: string, serverConfig: McpServerConfig): { clientSecret?: string } | undefined {
  const data = getSecureStorage().read()
  return (data?.mcpOAuthClientConfig as Record<string, { clientSecret?: string }> | undefined)?.[
    getServerKey(serverName, serverConfig)
  ]
}

/** Auth currency for the health check; counts only REAL credentials; never throws. */
export function summarizeMcpAuthCurrency(): { tokens: number; expired: number; expiringSoon: number } | null {
  try {
    const data = getSecureStorage().read()
    const entries = Object.values((data?.mcpOAuth as Record<string, StoredOAuthEntry> | undefined) ?? {})
    const real = entries.filter(entry => typeof entry?.accessToken === 'string' && entry.accessToken !== '')
    const now = Date.now()
    return {
      tokens: real.length,
      expired: real.filter(entry => entry.expiresAt > 0 && entry.expiresAt < now).length,
      expiringSoon: real.filter(entry => entry.expiresAt >= now && entry.expiresAt - now < EXPIRING_SOON_MS).length,
    }
  } catch {
    return null
  }
}
