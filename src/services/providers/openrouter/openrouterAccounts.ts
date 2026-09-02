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


const OPENROUTER_AUTH_PAGE = 'https://openrouter.ai/auth'
const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1'
const OPENROUTER_REDIRECT_PORT = 1456
const openrouterRedirectUri = (port: number): string =>
  `http://127.0.0.1:${port}/auth/callback`
const OPENROUTER_KEY_LABEL = 'Mercury'

function openrouterAuthPage(env: NodeJS.ProcessEnv = process.env): string {
  return env['MERCURY_OPENROUTER_AUTH_BASE']?.trim() || OPENROUTER_AUTH_PAGE
}
const LOGIN_EXCHANGE_TIMEOUT_MS = 15_000

export function openrouterApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return env['MERCURY_OPENROUTER_API_BASE']?.trim() || OPENROUTER_API_BASE
}


const OPENROUTER_AUTH_VERSION = 1
const AUTH_FILE_NAME = '.openrouter-auth.json'

export interface OpenrouterMintedKey {
  key: string
  mintedAtMs: number
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
  durableAtomicPublishSync(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
  }
}

export function openrouterAuthFileExists(): boolean {
  return existsSync(authFilePath())
}

export function openrouterAuthPathForDisplay(): string {
  return authFilePath()
}

export function readMintedOpenrouterKey(): OpenrouterMintedKey | undefined {
  const minted = readAuthFile()?.minted
  if (!minted || typeof minted.key !== 'string' || !minted.key.trim()) return undefined
  return minted
}

export function disconnectOpenrouterOauthKey(): void {
  writeAuthFile(file => {
    const next = { ...file }
    delete next.minted
    return next
  })
}


export type OpenrouterKeySource = 'env' | 'oauth' | 'stored'

export interface OpenrouterAccountRef {
  provider: 'openrouter'
  kind: 'oauth-key' | 'api-key'
  label: string
  keySource: OpenrouterKeySource
}

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

export function openrouterKeySource(
  env: NodeJS.ProcessEnv = process.env,
): OpenrouterKeySource | undefined {
  return resolveOpenrouterApiKey(env)?.source
}

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


export interface OpenrouterRequestAuth {
  account: OpenrouterAccountRef
  baseUrl: string
  headers: Record<string, string>
}

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


export interface OpenrouterConnectHandles {
  authorizeUrl: string
  result: Promise<OpenrouterAccountRef>
  completeWithRedirect(pasted: string): void
  cancel(reason?: string): void
  boundLoopbackPort(): number | undefined
}

function buildOpenrouterAuthorizeUrl(
  env: NodeJS.ProcessEnv,
  challenge: string,
  mode: 'browser' | 'headless',
  redirectPort: number,
): string {
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
    throw new Error(
      `openrouter key exchange unreachable (${url}): ${errorMessageWithCause(error)}`,
    )
  }
  if (!response.ok) {
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

export function beginOpenrouterConnect(opts?: {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  mode?: 'browser' | 'headless'
  skipBrowserOpen?: boolean
  onListenerIssue?: (message: string) => void
  loopbackPort?: number
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

  const mint = async (code: string): Promise<void> => {
    exchangeInFlight = true
    try {
      const key = await exchangeOpenrouterCode(code, verifier, fetchImpl, env)
      writeAuthFile(file => ({
        ...file,
        minted: { key, mintedAtMs: Date.now(), label: OPENROUTER_KEY_LABEL },
      }))
      recordSignIn('openrouter', 'oauth')
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
