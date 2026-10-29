import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod/v4'
import { getMercuryHome } from '../../utils/envUtils.js'
import type { AutomationOAuthClient } from './automationAccess.js'
import {
  bearerAuthChallengeResponse,
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  requireBearerAuth,
  type AuthInfo,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from './sdk.js'

type ServerSdk = typeof import('@modelcontextprotocol/server')
type OAuthErrors = Pick<ServerSdk, 'OAuthError' | 'OAuthErrorCode'>
type OAuthErrorCode = ServerSdk['OAuthErrorCode'][keyof ServerSdk['OAuthErrorCode']]

const ACCESS_TOKEN_SECONDS = 3600
const REFRESH_TOKEN_SECONDS = 30 * 24 * 3600
const CODE_SECONDS = 60
const APPROVAL_SECONDS = 600
const APPROVAL_ATTEMPTS = 3
const RETIRED_REFRESH_TOKENS = 8
const FORM_LIMIT = 65_536

const grantSchema = z.strictObject({
  client: z.string(),
  client_id: z.string(),
  resource: z.string(),
  code: z.string(),
  access: z.string(),
  accessExpiresAt: z.number(),
  refresh: z.string(),
  refreshExpiresAt: z.number(),
  retired: z.array(z.string()),
})
type Grant = z.infer<typeof grantSchema>
type Pending = { id: string; client: AutomationOAuthClient; redirectUri: string; state: string | null; challenge: string; approval: string; attempts: number; expiresAt: number }
type IssuedCode = { client: AutomationOAuthClient; redirectUri: string; challenge: string; expiresAt: number }

const seconds = (): number => Date.now() / 1000
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const fresh = (): string => randomBytes(32).toString('base64url')
const escape = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const oauthError = (errors: OAuthErrors, status: number, code: OAuthErrorCode, description: string, headers: Record<string, string> = {}): Response =>
  Response.json(new errors.OAuthError(code, description).toResponseObject(), { status, headers: { 'cache-control': 'no-store', ...headers } })
const html = (status: number, title: string, body: string): Response => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}input{font:inherit;padding:.4rem;width:8rem}button{font:inherit;padding:.4rem 1rem}</style></head><body><h1>${title}</h1>${body}</body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' } },
)
const notice = (status: number, text: string): Response => html(status, 'Mercury', `<p>${escape(text)}</p>`)

export class AutomationGateway implements OAuthTokenVerifier {
  readonly issuer: string
  readonly resource: string
  readonly resourceMetadataUrl: string
  private readonly metadata: OAuthMetadata
  private readonly path: string
  private readonly gate: (request: Request) => Promise<AuthInfo | Response>
  private readonly pending = new Map<string, Pending>()
  private readonly codes = new Map<string, IssuedCode>()
  private grants: Grant[] = []

  static async create(options: { issuer: string; clients: readonly AutomationOAuthClient[]; log: (line: string) => void; path?: string }): Promise<AutomationGateway> {
    const sdk = await import('@modelcontextprotocol/server')
    return new AutomationGateway(options, { OAuthError: sdk.OAuthError, OAuthErrorCode: sdk.OAuthErrorCode })
  }
  constructor(private readonly options: { issuer: string; clients: readonly AutomationOAuthClient[]; log: (line: string) => void; path?: string }, private readonly errors: OAuthErrors) {
    this.issuer = new URL(options.issuer).origin
    this.resource = `${this.issuer}/mcp`
    this.resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(this.resource))
    const methods = ['client_secret_basic', 'client_secret_post', 'none']
    this.metadata = {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      revocation_endpoint: `${this.issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: methods,
      revocation_endpoint_auth_methods_supported: methods,
      authorization_response_iss_parameter_supported: true,
    }
    try { buildOAuthProtectedResourceMetadata({ oauthMetadata: this.metadata, resourceServerUrl: new URL(this.resource) }) }
    catch { throw new Error('An oauth client needs --origin, an HTTPS origin, unless the server listens on 127.0.0.1 or localhost') }
    this.path = options.path ?? join(getMercuryHome(), 'mcp-server', 'oauth-grants.json')
    this.gate = requireBearerAuth({ verifier: this, resourceMetadataUrl: this.resourceMetadataUrl })
    this.load()
  }

  private load(): void {
    let stored: unknown
    try { stored = JSON.parse(readFileSync(this.path, 'utf8')) } catch { return }
    const parsed = z.strictObject({ grants: z.array(grantSchema) }).safeParse(stored)
    if (!parsed.success) return
    const now = seconds()
    this.grants = parsed.data.grants.filter(grant => grant.resource === this.resource && grant.refreshExpiresAt > now && this.options.clients.some(client => client.name === grant.client && client.client_id === grant.client_id))
    if (this.grants.length !== parsed.data.grants.length) this.save()
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const staged = `${this.path}.${process.pid}.tmp`
    writeFileSync(staged, JSON.stringify({ grants: this.grants }), { mode: 0o600 })
    renameSync(staged, this.path)
  }

  private drop(grant: Grant): void {
    this.grants = this.grants.filter(row => row !== grant)
    this.save()
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const hash = digest(token)
    const grant = this.grants.find(row => same(row.access, hash))
    if (!grant) throw new this.errors.OAuthError(this.errors.OAuthErrorCode.InvalidToken, 'Unknown token')
    if (grant.accessExpiresAt <= seconds()) throw new this.errors.OAuthError(this.errors.OAuthErrorCode.InvalidToken, 'Token has expired')
    return { token, clientId: grant.client_id, scopes: [], expiresAt: grant.accessExpiresAt, resource: new URL(grant.resource), extra: { client: grant.client } }
  }

  async authenticate(request: Request): Promise<{ client: string; authInfo: AuthInfo } | Response> {
    const verdict = await this.gate(request)
    return verdict instanceof Response ? verdict : { client: String(verdict.extra?.client), authInfo: verdict }
  }

  challenge(): Response {
    return bearerAuthChallengeResponse(new this.errors.OAuthError(this.errors.OAuthErrorCode.InvalidToken, 'Bearer token required'), { resourceMetadataUrl: this.resourceMetadataUrl })
  }

  async fetch(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '')
    if (path === '/.well-known/oauth-protected-resource') return this.wellKnown(new Request(new URL('/.well-known/oauth-protected-resource/mcp', url), request))
    if (path.startsWith('/.well-known/')) return this.wellKnown(request)
    if (path === '/oauth/authorize') return request.method === 'GET' ? this.authorize(url) : request.method === 'POST' ? this.decide(request) : this.methodNotAllowed('GET, POST')
    if (path === '/oauth/token') return request.method === 'POST' ? this.token(request) : this.methodNotAllowed('POST')
    if (path === '/oauth/revoke') return request.method === 'POST' ? this.revoke(request) : this.methodNotAllowed('POST')
    return undefined
  }

  private wellKnown(request: Request): Response | undefined {
    return oauthMetadataResponse(request, { oauthMetadata: this.metadata, resourceServerUrl: new URL(this.resource) })
  }

  private methodNotAllowed(allow: string): Response {
    return new Response(null, { status: 405, headers: { allow } })
  }

  private async form(request: Request): Promise<URLSearchParams | undefined> {
    if (!/^application\/x-www-form-urlencoded\b/i.test(request.headers.get('content-type') ?? '')) return undefined
    if (Number(request.headers.get('content-length') ?? 0) > FORM_LIMIT) return undefined
    try { return new URLSearchParams(await request.text()) } catch { return undefined }
  }

  private bounce(redirectUri: string, state: string | null, params: Record<string, string>): Response {
    const target = new URL(redirectUri)
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value)
    if (state !== null) target.searchParams.set('state', state)
    target.searchParams.set('iss', this.issuer)
    return new Response(null, { status: 303, headers: { location: target.href, 'cache-control': 'no-store' } })
  }

  private consent(row: Pending, warning?: string): Response {
    const name = escape(row.client.name)
    const targets = row.client.send.length
    const reach = `${name} can send outside reports to ${targets} session${targets === 1 ? '' : 's'}${row.client.run ? ' and read reports in its own sessions, which spends your model usage. It cannot enter your sessions or approve anything.' : '. It cannot start work, approve anything or spend your model usage.'}`
    return html(200, `Connect ${name} to Mercury`, `<p>${reach}</p><p>Enter the approval code shown by <code>mercury mcp-server</code>.</p>${warning ? `<p>${escape(warning)}</p>` : ''}<form method="post" action="/oauth/authorize"><input type="hidden" name="request" value="${row.id}"><label>Approval code <input name="code" inputmode="numeric" autocomplete="one-time-code" required></label> <button name="decision" value="approve">Approve</button> <button name="decision" value="deny" formnovalidate>Deny</button></form>`)
  }

  private authorize(url: URL): Response {
    const query = url.searchParams
    const client = this.options.clients.find(row => row.client_id === query.get('client_id'))
    const redirectUri = query.get('redirect_uri')
    if (!client || redirectUri === null || !client.redirect_uris.includes(redirectUri)) return notice(400, 'This sign-in request names a client or redirect address that the token file does not allow.')
    const state = query.get('state')
    const fail = (code: string, description: string): Response => this.bounce(redirectUri, state, { error: code, error_description: description })
    if (query.get('response_type') !== 'code') return fail(this.errors.OAuthErrorCode.UnsupportedResponseType, 'Only response_type=code is supported')
    const challenge = query.get('code_challenge')
    if (challenge === null || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || query.get('code_challenge_method') !== 'S256') return fail(this.errors.OAuthErrorCode.InvalidRequest, 'PKCE with S256 is required')
    if (query.get('resource') !== this.resource) return fail(this.errors.OAuthErrorCode.InvalidTarget, `The resource must be ${this.resource}`)
    if (state !== null && state.length > 1024) return fail(this.errors.OAuthErrorCode.InvalidRequest, 'state is too long')
    const now = seconds()
    for (const [id, row] of this.pending) if (row.client.name === client.name || row.expiresAt <= now) this.pending.delete(id)
    const row: Pending = { id: fresh(), client, redirectUri, state, challenge, approval: String(randomInt(0, 1_000_000)).padStart(6, '0'), attempts: 0, expiresAt: now + APPROVAL_SECONDS }
    this.pending.set(row.id, row)
    this.options.log(`Approve ${client.name} with code ${row.approval} within ${APPROVAL_SECONDS / 60} minutes`)
    return this.consent(row)
  }

  private async decide(request: Request): Promise<Response> {
    const form = await this.form(request)
    if (!form) return notice(400, 'The form was not understood.')
    const row = this.pending.get(form.get('request') ?? '')
    if (!row || row.expiresAt <= seconds()) {
      if (row) this.pending.delete(row.id)
      return notice(400, 'This sign-in request has ended. Connect again from the client.')
    }
    if (form.get('decision') !== 'approve') {
      this.pending.delete(row.id)
      return this.bounce(row.redirectUri, row.state, { error: this.errors.OAuthErrorCode.AccessDenied, error_description: 'The operator denied the request' })
    }
    if (!same(row.approval, (form.get('code') ?? '').trim())) {
      row.attempts++
      if (row.attempts >= APPROVAL_ATTEMPTS) {
        this.pending.delete(row.id)
        return notice(403, 'The approval code was wrong three times. Connect again from the client.')
      }
      const left = APPROVAL_ATTEMPTS - row.attempts
      return this.consent(row, `That code was not accepted. ${left} ${left === 1 ? 'try' : 'tries'} left.`)
    }
    this.pending.delete(row.id)
    const code = fresh()
    this.codes.set(digest(code), { client: row.client, redirectUri: row.redirectUri, challenge: row.challenge, expiresAt: seconds() + CODE_SECONDS })
    return this.bounce(row.redirectUri, row.state, { code })
  }

  private clientAuth(request: Request, form: URLSearchParams): AutomationOAuthClient | Response {
    const header = request.headers.get('authorization') ?? ''
    const basic = /^basic\s/i.test(header)
    const refuse = (): Response => oauthError(this.errors, 401, this.errors.OAuthErrorCode.InvalidClient, 'Client authentication failed', basic ? { 'www-authenticate': 'Basic realm="mercury"' } : {})
    let id = form.get('client_id')
    let secret = form.get('client_secret')
    if (basic) {
      const decode = (value: string): string => { try { return decodeURIComponent(value) } catch { return value } }
      const [user = '', ...rest] = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8').split(':')
      if (id !== null && id !== decode(user)) return refuse()
      id = decode(user)
      secret = decode(rest.join(':'))
    }
    const client = this.options.clients.find(row => row.client_id === id)
    if (!client) return refuse()
    if (client.client_secret === undefined ? secret !== null && secret !== '' : secret === null || !same(digest(client.client_secret), digest(secret))) return refuse()
    return client
  }

  private mint(grant: Grant): Response {
    const access = fresh()
    const refresh = fresh()
    const now = seconds()
    grant.access = digest(access)
    grant.accessExpiresAt = now + ACCESS_TOKEN_SECONDS
    if (grant.refresh) grant.retired = [grant.refresh, ...grant.retired].slice(0, RETIRED_REFRESH_TOKENS)
    grant.refresh = digest(refresh)
    grant.refreshExpiresAt = now + REFRESH_TOKEN_SECONDS
    this.save()
    return Response.json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refresh }, { headers: { 'cache-control': 'no-store', pragma: 'no-cache' } })
  }

  private async token(request: Request): Promise<Response> {
    const form = await this.form(request)
    if (!form) return oauthError(this.errors, 400, this.errors.OAuthErrorCode.InvalidRequest, 'Send application/x-www-form-urlencoded parameters')
    const client = this.clientAuth(request, form)
    if (client instanceof Response) return client
    const resource = form.get('resource')
    if (resource !== null && resource !== this.resource) return oauthError(this.errors, 400, this.errors.OAuthErrorCode.InvalidTarget, `The resource must be ${this.resource}`)
    const grantType = form.get('grant_type')
    if (grantType === 'authorization_code') return this.exchange(client, form)
    if (grantType === 'refresh_token') return this.refresh(client, form)
    return oauthError(this.errors, 400, this.errors.OAuthErrorCode.UnsupportedGrantType, 'Use authorization_code or refresh_token')
  }

  private exchange(client: AutomationOAuthClient, form: URLSearchParams): Response {
    const hash = digest(form.get('code') ?? '')
    const issued = this.codes.get(hash)
    if (!issued) {
      const replayed = this.grants.find(row => same(row.code, hash))
      if (replayed) this.drop(replayed)
      return oauthError(this.errors, 400, this.errors.OAuthErrorCode.InvalidGrant, 'The authorization code is unknown, used or expired')
    }
    this.codes.delete(hash)
    const verifier = form.get('code_verifier') ?? ''
    const bound = issued.expiresAt > seconds() && issued.client.name === client.name && form.get('redirect_uri') === issued.redirectUri
      && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) && same(createHash('sha256').update(verifier).digest('base64url'), issued.challenge)
    if (!bound) return oauthError(this.errors, 400, this.errors.OAuthErrorCode.InvalidGrant, 'The authorization code does not match this request')
    const grant: Grant = { client: client.name, client_id: client.client_id, resource: this.resource, code: hash, access: '', accessExpiresAt: 0, refresh: '', refreshExpiresAt: 0, retired: [] }
    this.grants.push(grant)
    const tokens = this.mint(grant)
    this.options.log(`${client.name} connected`)
    return tokens
  }

  private refresh(client: AutomationOAuthClient, form: URLSearchParams): Response {
    const hash = digest(form.get('refresh_token') ?? '')
    const grant = this.grants.find(row => same(row.refresh, hash))
    if (!grant || grant.client !== client.name || grant.refreshExpiresAt <= seconds()) {
      const reused = this.grants.find(row => row.retired.some(old => same(old, hash)))
      if (reused) this.drop(reused)
      return oauthError(this.errors, 400, this.errors.OAuthErrorCode.InvalidGrant, 'The refresh token is unknown, rotated or expired')
    }
    return this.mint(grant)
  }

  private async revoke(request: Request): Promise<Response> {
    const form = await this.form(request)
    if (!form) return oauthError(this.errors, 400, this.errors.OAuthErrorCode.InvalidRequest, 'Send application/x-www-form-urlencoded parameters')
    const client = this.clientAuth(request, form)
    if (client instanceof Response) return client
    const hash = digest(form.get('token') ?? '')
    const held = this.grants.find(row => row.client === client.name && (same(row.access, hash) || same(row.refresh, hash) || row.retired.some(old => same(old, hash))))
    if (held) this.drop(held)
    return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } })
  }
}
