/**
 * Cross-App Access (XAA / SEP-990): obtain an MCP access token WITHOUT a
 * browser consent screen by chaining two standard grants —
 *
 *   1. RFC 8693 token exchange at the enterprise IdP: the OIDC id_token is
 *      exchanged for an identity-assertion authorization grant (ID-JAG);
 *   2. RFC 7523 JWT-bearer grant at the MCP server's authorization server:
 *      the ID-JAG becomes an access token.
 *
 * Discovery (RFC 9728 protected-resource metadata + RFC 8414 authorization-
 * server metadata) rides the MCP SDK's own discovery helpers; this module
 * adds the mix-up protections and transport requirements on top.
 */
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from './sdk.js'

import { logMCPDebug } from '../../utils/log.js'

// ---------------------------------------------------------------------------
// Protocol constants (contract data — these exact URNs go on the wire)
// ---------------------------------------------------------------------------

const TOKEN_EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange'
const JWT_BEARER_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
const ID_JAG_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id-jag'
const ID_TOKEN_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token'

const REQUEST_TIMEOUT_MS = 30_000
const BODY_EXCERPT_LIMIT = 200

type FetchLike = typeof fetch

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * A token-exchange failure carrying the "should the cached id_token be
 * dropped?" decision, derived from OAuth semantics (never substring
 * matching): 4xx ⇒ the token is bad, drop it; 5xx and non-JSON bodies ⇒ the
 * IdP or network is unhealthy, keep it; a 200 violating the protocol ⇒ drop.
 */
export class XaaTokenExchangeError extends Error {
  readonly shouldClearIdToken: boolean

  constructor(message: string, shouldClearIdToken: boolean) {
    super(message)
    this.name = 'XaaTokenExchangeError'
    this.shouldClearIdToken = shouldClearIdToken
  }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type ProtectedResourceMetadata = {
  resource: string
  authorizationServers: string[]
}

export type AuthorizationServerMetadata = {
  issuer: string
  tokenEndpoint: string
  grantTypesSupported?: string[]
  tokenEndpointAuthMethods?: string[]
}

export type JwtAuthGrantResult = {
  /** The ID-JAG assertion presented to the authorization server. */
  grant: string
  expiresIn?: number
}

export type XaaTokenResult = {
  access_token: string
  token_type: string
  expires_in?: number
  scope?: string
  refresh_token?: string
}

/** The orchestrated result: token fields plus the DISCOVERED authorization-
 *  server issuer — callers must persist it, because refresh and revocation
 *  need to locate the token/revocation endpoints and the MCP server URL is
 *  not the authorization-server URL in typical XAA deployments. */
export type XaaResult = XaaTokenResult & { authorizationServerUrl: string }

export type XaaConfig = {
  /** Client credentials at the MCP server's authorization server. */
  clientId: string
  clientSecret: string
  /** Client credentials at the enterprise IdP. */
  idpClientId: string
  idpClientSecret?: string
  /** The cached OIDC id_token (the subject of the exchange). */
  idpIdToken: string
  /** The IdP's token endpoint (from OIDC discovery). */
  idpTokenEndpoint: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compose a caller's abort signal with the request timeout (never replace). */
function composeSignal(abortSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  if (abortSignal === undefined) return timeout
  return AbortSignal.any([abortSignal, timeout])
}

/**
 * URL comparison after round-tripping through URL parsing (lower-cases
 * scheme and host, drops the default port) and stripping a single trailing
 * slash. Unparseable input falls back to trailing-slash stripping only.
 */
function normalizeUrlForComparison(input: string): string {
  try {
    const text = new URL(input).toString()
    return text.endsWith('/') ? text.slice(0, -1) : text
  } catch {
    return input.endsWith('/') ? input.slice(0, -1) : input
  }
}

function urlsEqual(a: string, b: string): boolean {
  return normalizeUrlForComparison(a) === normalizeUrlForComparison(b)
}

/** The keys a misbehaving server may echo back (contract data). */
const SENSITIVE_KEYS = [
  'access_token',
  'refresh_token',
  'id_token',
  'assertion',
  'subject_token',
  'client_secret',
] as const

const REDACTED = '[REDACTED]'

/**
 * Redact every JSON string value under a sensitive key, at any nesting
 * depth, in parsed objects AND raw text bodies (a non-OK response may echo
 * the request's own secrets back inside an error envelope). Non-string
 * inputs are serialised first so one routine covers both.
 */
function redactSensitive(input: unknown): string {
  let text: string
  if (typeof input === 'string') {
    text = input
  } else {
    try {
      text = JSON.stringify(input) ?? String(input)
    } catch {
      text = String(input)
    }
  }
  for (const key of SENSITIVE_KEYS) {
    text = text.replace(
      new RegExp(`("${key}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'g'),
      `$1"${REDACTED}"`,
    )
    // Form-encoded echoes: key=value up to the next separator.
    text = text.replace(new RegExp(`(${key}=)[^&\\s"']+`, 'g'), `$1${REDACTED}`)
  }
  return text
}

/** Redact FIRST, then truncate — truncating first can cut a match in half
 *  and let a secret through. */
function redactedExcerpt(body: unknown): string {
  return redactSensitive(body).slice(0, BODY_EXCERPT_LIMIT)
}

/** `expires_in` arrives as a number or a numeric string (widespread
 *  non-conformance); anything else reads as absent. */
function readExpiresIn(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Protected-resource discovery (RFC 9728) with mix-up protection: the
 * document must carry a resource identifier and at least one authorization
 * server, and the advertised resource must equal the requested server URL
 * under normalisation. Any discovery exception is re-thrown wrapped, naming
 * protected-resource discovery and carrying the cause.
 */
export async function discoverProtectedResource(
  serverUrl: string,
  opts?: { fetchFn?: FetchLike },
): Promise<ProtectedResourceMetadata> {
  let metadata: { resource?: string; authorization_servers?: string[] } | undefined
  try {
    metadata = (await discoverOAuthProtectedResourceMetadata(serverUrl, undefined, opts?.fetchFn)) as {
      resource?: string
      authorization_servers?: string[]
    }
  } catch (error) {
    throw new Error(
      `XAA protected resource discovery failed for ${serverUrl}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  const resource = metadata?.resource
  const authorizationServers = metadata?.authorization_servers
  if (!resource || !authorizationServers || authorizationServers.length === 0) {
    throw new Error(
      `XAA protected resource metadata for ${serverUrl} is missing ${!resource ? 'resource' : 'authorization_servers'}`,
    )
  }
  if (!urlsEqual(resource, serverUrl)) {
    throw new Error(
      `XAA protected resource metadata mismatch: expected resource ${serverUrl}, received ${resource}`,
    )
  }
  return { resource, authorizationServers }
}

/**
 * Authorization-server discovery (RFC 8414). The SDK's own discovery failure
 * propagates UNWRAPPED — that is what lets the orchestrator record it
 * verbatim as a per-server reason. Enforced on top: issuer + token endpoint
 * present, issuer equality under normalisation, and an `https:` token
 * endpoint (a plaintext endpoint would receive an id_token and a client
 * secret in the clear).
 */
export async function discoverAuthorizationServer(
  asUrl: string,
  opts?: { fetchFn?: FetchLike },
): Promise<AuthorizationServerMetadata> {
  const metadata = (await discoverAuthorizationServerMetadata(asUrl, {
    ...(opts?.fetchFn === undefined ? {} : { fetchFn: opts.fetchFn }),
  })) as
    | {
        issuer?: string
        token_endpoint?: string
        grant_types_supported?: string[]
        token_endpoint_auth_methods_supported?: string[]
      }
    | undefined
  if (!metadata?.issuer || !metadata.token_endpoint) {
    throw new Error(`No valid authorization server metadata at ${asUrl}`)
  }
  if (!urlsEqual(metadata.issuer, asUrl)) {
    throw new Error(
      `authorization server metadata mismatch: expected issuer ${asUrl}, received ${metadata.issuer}`,
    )
  }
  if (!metadata.token_endpoint.startsWith('https:')) {
    throw new Error(
      `authorization server token endpoint ${metadata.token_endpoint} is not https — refusing to send credentials in the clear`,
    )
  }
  return {
    issuer: metadata.issuer,
    tokenEndpoint: metadata.token_endpoint,
    ...(metadata.grant_types_supported === undefined
      ? {}
      : { grantTypesSupported: metadata.grant_types_supported }),
    ...(metadata.token_endpoint_auth_methods_supported === undefined
      ? {}
      : { tokenEndpointAuthMethods: metadata.token_endpoint_auth_methods_supported }),
  }
}

// ---------------------------------------------------------------------------
// Token exchange at the IdP (RFC 8693)
// ---------------------------------------------------------------------------

/**
 * Exchange the OIDC id_token for the ID-JAG authorization grant at the
 * enterprise IdP. An IdP client secret, when supplied, travels as a form
 * parameter — this leg has no Basic-auth alternative.
 */
export async function requestJwtAuthorizationGrant({
  tokenEndpoint,
  audience,
  resource,
  idToken,
  clientId,
  clientSecret,
  scope,
  fetchFn,
  abortSignal,
}: {
  tokenEndpoint: string
  audience: string
  resource: string
  idToken: string
  clientId: string
  clientSecret?: string
  scope?: string
  fetchFn?: FetchLike
  abortSignal?: AbortSignal
}): Promise<JwtAuthGrantResult> {
  const body = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    requested_token_type: ID_JAG_TOKEN_TYPE,
    audience,
    resource,
    subject_token: idToken,
    subject_token_type: ID_TOKEN_TOKEN_TYPE,
    client_id: clientId,
  })
  if (clientSecret !== undefined && clientSecret !== '') body.set('client_secret', clientSecret)
  if (scope !== undefined) body.set('scope', scope)

  const doFetch = fetchFn ?? fetch
  const response = await doFetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: composeSignal(abortSignal),
  })

  const rawBody = await response.text()
  if (!response.ok) {
    // 4xx ⇒ the token is bad; 5xx ⇒ the IdP is down, the token may be fine.
    const shouldClear = response.status < 500
    throw new XaaTokenExchangeError(
      `XAA token exchange failed with status ${response.status}: ${redactedExcerpt(rawBody)}`,
      shouldClear,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    // Captive portal / proxy — a transient network condition, keep the token.
    throw new XaaTokenExchangeError(
      `XAA token exchange returned a non-JSON body (captive portal or proxy?): ${redactedExcerpt(rawBody)}`,
      false,
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new XaaTokenExchangeError(
      `XAA token exchange returned an unexpected response shape: ${redactedExcerpt(rawBody)}`,
      true,
    )
  }
  const record = parsed as {
    access_token?: unknown
    issued_token_type?: unknown
    expires_in?: unknown
  }
  if (typeof record.access_token !== 'string' || record.access_token === '') {
    throw new XaaTokenExchangeError(
      `XAA token exchange succeeded but returned no access token: ${redactedExcerpt(rawBody)}`,
      true,
    )
  }
  if (record.issued_token_type !== ID_JAG_TOKEN_TYPE) {
    throw new XaaTokenExchangeError(
      `XAA token exchange issued ${String(record.issued_token_type)} instead of the ID-JAG token type`,
      true,
    )
  }
  const expiresIn = readExpiresIn(record.expires_in)
  return { grant: record.access_token, ...(expiresIn === undefined ? {} : { expiresIn }) }
}

// ---------------------------------------------------------------------------
// JWT-bearer grant at the authorization server (RFC 7523)
// ---------------------------------------------------------------------------

/** Percent-encode then Basic-encode per the conformance suite's requirement. */
function basicAuthorization(clientId: string, clientSecret: string): string {
  const credentials = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`
  return `Basic ${Buffer.from(credentials, 'utf-8').toString('base64')}`
}

/**
 * Exchange the ID-JAG for an access token at the MCP server's authorization
 * server. Client authentication defaults to HTTP Basic
 * (`client_secret_basic`); `client_secret_post` sends the credentials as
 * form parameters instead.
 */
export async function exchangeJwtAuthGrant({
  tokenEndpoint,
  assertion,
  clientId,
  clientSecret,
  authMethod = 'client_secret_basic',
  scope,
  fetchFn,
  abortSignal,
}: {
  tokenEndpoint: string
  assertion: string
  clientId: string
  clientSecret: string
  authMethod?: 'client_secret_basic' | 'client_secret_post'
  scope?: string
  fetchFn?: FetchLike
  abortSignal?: AbortSignal
}): Promise<XaaTokenResult> {
  const body = new URLSearchParams({
    grant_type: JWT_BEARER_GRANT_TYPE,
    assertion,
  })
  if (scope !== undefined) body.set('scope', scope)
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  if (authMethod === 'client_secret_post') {
    body.set('client_id', clientId)
    body.set('client_secret', clientSecret)
  } else {
    headers['Authorization'] = basicAuthorization(clientId, clientSecret)
  }

  const doFetch = fetchFn ?? fetch
  const response = await doFetch(tokenEndpoint, {
    method: 'POST',
    headers,
    body: body.toString(),
    signal: composeSignal(abortSignal),
  })

  const rawBody = await response.text()
  if (!response.ok) {
    throw new Error(
      `XAA jwt-bearer grant failed with status ${response.status}: ${redactedExcerpt(rawBody)}`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    throw new Error(
      `XAA jwt-bearer grant returned a non-JSON body (captive portal or proxy?): ${redactedExcerpt(rawBody)}`,
    )
  }
  const record = parsed as {
    access_token?: unknown
    token_type?: unknown
    expires_in?: unknown
    scope?: unknown
    refresh_token?: unknown
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof record.access_token !== 'string' ||
    record.access_token === ''
  ) {
    throw new Error(
      `XAA jwt-bearer grant returned an unexpected response shape: ${redactedExcerpt(rawBody)}`,
    )
  }
  const expiresIn = readExpiresIn(record.expires_in)
  return {
    access_token: record.access_token,
    // Many servers omit token_type — Bearer is the only value in use.
    token_type: typeof record.token_type === 'string' ? record.token_type : 'Bearer',
    ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
    ...(typeof record.scope === 'string' ? { scope: record.scope } : {}),
    ...(typeof record.refresh_token === 'string' ? { refresh_token: record.refresh_token } : {}),
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * The full XAA chain: discover the protected resource; walk its advertised
 * authorization servers IN ORDER (recording per-server reasons, propagating
 * immediately on a caller abort); exchange the id_token for the ID-JAG at
 * the IdP; exchange the ID-JAG for an access token at the authorization
 * server. The result carries the discovered issuer.
 */
export async function performCrossAppAccess(
  serverUrl: string,
  config: XaaConfig,
  serverName?: string,
  abortSignal?: AbortSignal,
): Promise<XaaResult> {
  const label = serverName ?? 'XAA'
  logMCPDebug(label, `XAA: discovering protected resource for ${serverUrl}`)
  const resource = await discoverProtectedResource(serverUrl)
  logMCPDebug(
    label,
    `XAA: resource ${resource.resource} advertises ${resource.authorizationServers.length} authorization server(s)`,
  )

  const failures: Array<{ server: string; reason: string }> = []
  let selected: AuthorizationServerMetadata | undefined
  for (const candidate of resource.authorizationServers) {
    if (abortSignal?.aborted) {
      throw new Error(`XAA aborted while discovering authorization servers for ${serverUrl}`)
    }
    let metadata: AuthorizationServerMetadata
    try {
      metadata = await discoverAuthorizationServer(candidate)
    } catch (error) {
      if (abortSignal?.aborted) throw error
      failures.push({
        server: candidate,
        reason: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    // A server advertising a grant list WITHOUT jwt-bearer is skipped; one
    // advertising no list is not (the field is optional — let the token
    // endpoint decide).
    if (
      metadata.grantTypesSupported !== undefined &&
      !metadata.grantTypesSupported.includes(JWT_BEARER_GRANT_TYPE)
    ) {
      failures.push({
        server: candidate,
        reason: `does not support the jwt-bearer grant (advertises: ${metadata.grantTypesSupported.join(', ')})`,
      })
      continue
    }
    selected = metadata
    break
  }

  if (selected === undefined) {
    const detail = failures.map(failure => `${failure.server}: ${failure.reason}`).join('; ')
    throw new Error(`no authorization server for ${serverUrl} supports XAA — ${detail}`)
  }

  // Form-parameter auth only when the server advertises a method list that
  // omits Basic and includes Post; otherwise Basic.
  const methods = selected.tokenEndpointAuthMethods
  const authMethod: 'client_secret_basic' | 'client_secret_post' =
    methods !== undefined &&
    !methods.includes('client_secret_basic') &&
    methods.includes('client_secret_post')
      ? 'client_secret_post'
      : 'client_secret_basic'
  logMCPDebug(
    label,
    `XAA: selected issuer ${selected.issuer} (token endpoint ${selected.tokenEndpoint}, auth ${authMethod})`,
  )

  logMCPDebug(label, 'XAA: exchanging id_token for the authorization grant at the IdP')
  const grant = await requestJwtAuthorizationGrant({
    tokenEndpoint: config.idpTokenEndpoint,
    audience: selected.issuer,
    resource: resource.resource,
    idToken: config.idpIdToken,
    clientId: config.idpClientId,
    ...(config.idpClientSecret === undefined || config.idpClientSecret === null
      ? {}
      : { clientSecret: config.idpClientSecret }),
    abortSignal,
  })
  logMCPDebug(label, 'XAA: authorization grant obtained')

  const token = await exchangeJwtAuthGrant({
    tokenEndpoint: selected.tokenEndpoint,
    assertion: grant.grant,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    authMethod,
    abortSignal,
  })
  logMCPDebug(label, 'XAA: access token obtained')

  return { ...token, authorizationServerUrl: selected.issuer }
}
