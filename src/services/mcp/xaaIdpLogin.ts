import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'

import {
  startAuthorization,
  exchangeAuthorization,
} from './sdk.js'
import { OpenIdProviderMetadataSchema } from './sdk.js'
import { escape as escapeHtml } from 'lodash-es'

import { openBrowser } from '../../utils/browser.js'
import { logForDebugging } from '../../utils/debug.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { buildRedirectUri, findAvailablePort } from './oauthPort.js'


export function isXaaEnabled(): boolean {
  return false
}

export type XaaIdpSettings = {
  issuer: string
  clientId: string
  callbackPort?: number
}

export function getXaaIdpSettings(): XaaIdpSettings | undefined {
  return (getInitialSettings() as { xaaIdp?: XaaIdpSettings } | undefined)?.xaaIdp
}


export function issuerKey(issuer: string): string {
  try {
    return new URL(issuer).toString().replace(/\/+$/, '')
  } catch {
    return issuer.replace(/\/+$/, '')
  }
}

const EXPIRY_MARGIN_MS = 60_000
const DEFAULT_TOKEN_LIFETIME_MS = 60 * 60 * 1000

type CachedIdToken = { idToken: string; expiresAt: number }

function decodeJwtExpiryMs(idToken: string): number | undefined {
  const segments = idToken.split('.')
  if (segments.length !== 3) return undefined
  try {
    const payload = JSON.parse(
      Buffer.from(segments[1] as string, 'base64url').toString('utf-8'),
    ) as { exp?: unknown }
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return undefined
    return payload.exp * 1000
  } catch {
    return undefined
  }
}

function readIdTokenCache(): Record<string, CachedIdToken> {
  const data = getSecureStorage().read()
  return (data?.mcpXaaIdp ?? {}) as Record<string, CachedIdToken>
}

export function getCachedIdpIdToken(issuer: string): string | undefined {
  const entry = readIdTokenCache()[issuerKey(issuer)]
  if (entry === undefined) return undefined
  if (typeof entry.idToken !== 'string' || typeof entry.expiresAt !== 'number') return undefined
  if (Date.now() + EXPIRY_MARGIN_MS >= entry.expiresAt) return undefined
  return entry.idToken
}

function writeIdTokenCache(issuer: string, idToken: string, expiresAt: number): void {
  const storage = getSecureStorage()
  const current = storage.read() ?? {}
  storage.update({
    ...current,
    mcpXaaIdp: {
      ...((current.mcpXaaIdp ?? {}) as Record<string, CachedIdToken>),
      [issuerKey(issuer)]: { idToken, expiresAt },
    },
  })
}

export function saveIdpIdTokenFromJwt(issuer: string, idToken: string): number {
  const expiresAt = decodeJwtExpiryMs(idToken) ?? Date.now() + DEFAULT_TOKEN_LIFETIME_MS
  writeIdTokenCache(issuer, idToken, expiresAt)
  return expiresAt
}

export function clearIdpIdToken(issuer: string): void {
  const storage = getSecureStorage()
  const current = storage.read()
  const cache = (current?.mcpXaaIdp ?? {}) as Record<string, CachedIdToken>
  const key = issuerKey(issuer)
  if (!(key in cache)) return
  const { [key]: _removed, ...rest } = cache
  storage.update({ ...(current ?? {}), mcpXaaIdp: rest })
}


type IdpConfigEntry = { clientSecret: string }

export function saveIdpClientSecret(
  issuer: string,
  secret: string,
): { success: boolean; warning?: string } {
  const storage = getSecureStorage()
  const current = storage.read() ?? {}
  return storage.update({
    ...current,
    mcpXaaIdpConfig: {
      ...((current.mcpXaaIdpConfig ?? {}) as Record<string, IdpConfigEntry>),
      [issuerKey(issuer)]: { clientSecret: secret },
    },
  })
}

export function getIdpClientSecret(issuer: string): string | undefined {
  const data = getSecureStorage().read()
  const entry = ((data?.mcpXaaIdpConfig ?? {}) as Record<string, IdpConfigEntry>)[
    issuerKey(issuer)
  ]
  return typeof entry?.clientSecret === 'string' ? entry.clientSecret : undefined
}

export function clearIdpClientSecret(issuer: string): void {
  const storage = getSecureStorage()
  const current = storage.read()
  const configs = (current?.mcpXaaIdpConfig ?? {}) as Record<string, IdpConfigEntry>
  const key = issuerKey(issuer)
  if (!(key in configs)) return
  const { [key]: _removed, ...rest } = configs
  storage.update({ ...(current ?? {}), mcpXaaIdpConfig: rest })
}


export type OidcMetadata = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  [key: string]: unknown
}

const DISCOVERY_TIMEOUT_MS = 30_000

export async function discoverOidc(issuer: string): Promise<OidcMetadata> {
  const base = issuer.endsWith('/') ? issuer : `${issuer}/`
  const url = new URL('.well-known/openid-configuration', base).toString()
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`OIDC discovery failed with status ${response.status} at ${url}`)
  }
  const raw = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      `OIDC discovery at ${url} returned a non-JSON body — a captive portal or proxy may be intercepting the request`,
    )
  }
  const validated = OpenIdProviderMetadataSchema.safeParse(parsed)
  if (!validated.success) {
    throw new Error(`OIDC discovery document at ${url} is invalid: ${validated.error.message}`)
  }
  const metadata = validated.data as OidcMetadata
  if (!metadata.token_endpoint.startsWith('https:')) {
    throw new Error(
      `OIDC token endpoint ${metadata.token_endpoint} is not https — refusing to send credentials in the clear`,
    )
  }
  return metadata
}


const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

function page(body: string): string {
  return `<html><body>${body}</body></html>`
}

function portHolderCommand(port: number): string {
  if (process.platform === 'win32') return `netstat -ano | findstr :${port}`
  return `lsof -nP -iTCP:${port} -sTCP:LISTEN`
}

function waitForLoopbackCallback({
  port,
  state,
  abortSignal,
  onBound,
}: {
  port: number
  state: string
  abortSignal?: AbortSignal
  onBound: () => void | Promise<void>
}): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    if (abortSignal?.aborted) {
      rejectPromise(new Error('IdP login was cancelled'))
      return
    }
    let server: Server | null = null
    let settled = false
    let timeout: NodeJS.Timeout | null = null
    const onAbort = (): void => {
      finish(() => rejectPromise(new Error('IdP login was cancelled')))
    }
    const cleanup = (): void => {
      if (server !== null) {
        server.removeAllListeners()
        server.on('error', () => {})
        server.close()
        server = null
      }
      if (timeout !== null) {
        clearTimeout(timeout)
        timeout = null
      }
      abortSignal?.removeEventListener('abort', onAbort)
    }
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      settle()
    }
    abortSignal?.addEventListener('abort', onAbort, { once: true })

    server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
      if (requestUrl.pathname !== '/callback') {
        response.writeHead(404)
        response.end()
        return
      }
      const params = requestUrl.searchParams
      const errorParam = params.get('error')
      if (errorParam !== null) {
        const description = params.get('error_description')
        response.writeHead(400, { 'Content-Type': 'text/html' })
        response.end(
          page(
            `<h1>IdP login failed</h1><p>${escapeHtml(errorParam)}${description ? `: ${escapeHtml(description)}` : ''}</p>`,
          ),
        )
        finish(() =>
          rejectPromise(
            new Error(`IdP login failed: ${errorParam}${description ? ` (${description})` : ''}`),
          ),
        )
        return
      }
      if (params.get('state') !== state) {
        response.writeHead(400, { 'Content-Type': 'text/html' })
        response.end(page('<h1>State mismatch</h1><p>The state parameter did not match.</p>'))
        finish(() =>
          rejectPromise(new Error('IdP login state mismatch — possible CSRF attempt')),
        )
        return
      }
      const code = params.get('code')
      if (code === null || code === '') {
        response.writeHead(400, { 'Content-Type': 'text/html' })
        response.end(page('<h1>Missing code</h1><p>The authorization code was absent.</p>'))
        finish(() => rejectPromise(new Error('IdP login callback was missing the authorization code')))
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end(page('<h1>Login complete</h1><p>You can close this window.</p>'))
      finish(() => resolvePromise(code))
    })

    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        finish(() =>
          rejectPromise(
            new Error(
              `Port ${port} is already in use. Find the process holding it with: ${portHolderCommand(port)}`,
            ),
          ),
        )
        return
      }
      finish(() => rejectPromise(new Error(`IdP login listener failed: ${error.message}`)))
    })

    timeout = setTimeout(() => {
      finish(() => rejectPromise(new Error('IdP login timed out after 5 minutes')))
    }, LOGIN_TIMEOUT_MS)
    timeout.unref?.()

    server.listen(port, '127.0.0.1', () => {
      server?.unref()
      Promise.resolve()
        .then(onBound)
        .catch(error => {
          finish(() =>
            rejectPromise(error instanceof Error ? error : new Error(String(error))),
          )
        })
    })
  })
}


export type IdpLoginOptions = {
  idpIssuer: string
  idpClientId: string
  idpClientSecret?: string
  callbackPort?: number
  onAuthorizationUrl?: (url: string) => void | Promise<void>
  skipBrowserOpen?: boolean
  abortSignal?: AbortSignal
}

export async function acquireIdpIdToken(options: IdpLoginOptions): Promise<string> {
  const cached = getCachedIdpIdToken(options.idpIssuer)
  if (cached !== undefined) {
    logForDebugging(`xaa idp login: using cached id_token for ${issuerKey(options.idpIssuer)}`)
    return cached
  }

  const metadata = await discoverOidc(options.idpIssuer)
  const port = options.callbackPort ?? (await findAvailablePort())
  const redirectUri = buildRedirectUri(port)
  const state = randomBytes(32).toString('base64url')

  const { authorizationUrl, codeVerifier } = await startAuthorization(options.idpIssuer, {
    metadata: metadata as never,
    clientInformation: { client_id: options.idpClientId },
    redirectUrl: redirectUri,
    scope: 'openid',
    state,
  })

  const code = await waitForLoopbackCallback({
    port,
    state,
    abortSignal: options.abortSignal,
    onBound: async () => {
      await options.onAuthorizationUrl?.(authorizationUrl.toString())
      if (options.skipBrowserOpen !== true) {
        logForDebugging(`xaa idp login: opening browser to ${authorizationUrl.toString()}`)
        await openBrowser(authorizationUrl.toString())
      }
    },
  })

  const tokens = (await exchangeAuthorization(options.idpIssuer, {
    metadata: metadata as never,
    clientInformation: {
      client_id: options.idpClientId,
      ...(options.idpClientSecret === undefined
        ? {}
        : { client_secret: options.idpClientSecret }),
    },
    authorizationCode: code,
    codeVerifier,
    redirectUri,
    fetchFn: (input, init) =>
      fetch(input as never, { ...(init as object), signal: AbortSignal.timeout(30_000) } as never),
  })) as { id_token?: string; expires_in?: number }

  const idToken = tokens.id_token
  if (idToken === undefined || idToken === '') {
    throw new Error(
      'The IdP token response carried no id_token — check that the openid scope was requested',
    )
  }

  const expiresAt =
    decodeJwtExpiryMs(idToken) ??
    (typeof tokens.expires_in === 'number'
      ? Date.now() + tokens.expires_in * 1000
      : Date.now() + DEFAULT_TOKEN_LIFETIME_MS)
  writeIdTokenCache(options.idpIssuer, idToken, expiresAt)
  logForDebugging(
    `xaa idp login: cached id_token for ${issuerKey(options.idpIssuer)} until ${new Date(expiresAt).toISOString()}`,
  )
  return idToken
}
