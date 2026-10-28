#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.GOOGLE_API_KEY
delete process.env.GEMINI_API_KEY
delete process.env.MERCURY_GEMINI_OAUTH_CLIENT_ID
delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC

let failures = 0
let passes = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const within = <T,>(promise: Promise<T>, ms = 4000): Promise<T | 'timed-out'> =>
  Promise.race([promise, new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), ms))])

type Capture = { host: 'google' | 'assist'; path: string; method: string; headers: Record<string, string>; body?: Record<string, unknown>; form?: Record<string, string> }
const requests: Capture[] = []
const google = { tokenStatus: 200, refreshStatus: 200, refreshError: undefined as string | undefined, withRefreshToken: true, serial: 0, userinfoStatus: 200, email: 'plan@example.invalid' }
const FREE = { id: 'free-tier', name: 'Free', isDefault: true }
const PRO = { id: 'g1-pro-tier', name: 'Google AI Pro' }
const assist = {
  loads: 0,
  tierShape: 'paid' as 'paid' | 'free' | 'onboard' | 'ineligible' | 'licence',
  onboarded: false,
  operationPolls: 0,
  onboardDoneAfterPolls: 2,
  loadStatus: 200,
  rosterStatus: 200,
  generateStatus: 200,
  generateError: undefined as Record<string, unknown> | undefined,
  dailyDown: false,
  dailyStatus: 503,
  roster: {
    'gemini-4-argon': { displayName: 'Gemini 4 Argon', supportsThinking: true, supportsImages: true, maxTokens: 1048576, maxOutputTokens: 65536, quotaInfo: { remainingFraction: 0.8, resetTime: '2026-10-15T00:00:00Z' } },
    'gemini-3.5-flash-low': { displayName: 'Gemini 3.5 Flash', supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536 },
    'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', supportsThinking: false, maxTokens: 200000, maxOutputTokens: 64000 },
    'claude-opus-4-6-thinking': { displayName: 'Claude Opus 4.6 (Thinking)', supportsThinking: true, maxTokens: 200000, maxOutputTokens: 128000 },
    'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B', supportsThinking: true, maxTokens: 131072, maxOutputTokens: 32768 },
    'gemini-4-helium-disabled': { displayName: 'Gemini 4 Helium', supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, quotaInfo: null },
    'gemini-4-neon-low': { displayName: 'Gemini 4 Neon', supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536 },
    'gemini-4-neon-medium': { displayName: 'Gemini 4 Neon', supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536 },
    'gemini-4-neon-high': { displayName: 'Gemini 4 Neon', supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536 },
    'gemini-3.1-flash-image': { displayName: 'Gemini 3.1 Flash Image', supportsImages: true },
    'chat_internal': { displayName: 'internal', isInternal: true },
  } as Record<string, Record<string, unknown>>,
  imageModelIds: ['gemini-3.1-flash-image'],
  lateRows: {} as Record<string, Record<string, unknown>>,
  rosterReads: 0,
  inFlightRefusals: 0,
  bareRefusals: 0,
  detailedRefusals: 0,
  chatBodies: [] as Array<Record<string, unknown>>,
}
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
const SCHEMA_PROTO_FIELDS: Record<string, string> = { type: 'type', format: 'format', title: 'title', description: 'description', nullable: 'nullable', enum: 'enum', items: 'items', maxItems: 'max_items', minItems: 'min_items', properties: 'properties', required: 'required', minProperties: 'min_properties', maxProperties: 'max_properties', minimum: 'minimum', maximum: 'maximum', minLength: 'min_length', maxLength: 'max_length', pattern: 'pattern', example: 'example', anyOf: 'any_of', propertyOrdering: 'property_ordering', default: 'default', additionalProperties: 'additional_properties', oneOf: 'one_of' }
function schemaGrammarViolations(schema: unknown, path: string, out: string[]): void {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    const field = SCHEMA_PROTO_FIELDS[key]
    if (field === undefined) {
      out.push(`Invalid JSON payload received. Unknown name "${key}" at '${path}': Cannot find field.`)
      continue
    }
    if (key === 'properties' && typeof value === 'object' && value !== null) Object.values(value as Record<string, unknown>).forEach((sub, index) => schemaGrammarViolations(sub, `${path}.properties[${index}].value`, out))
    else if (key === 'items' || key === 'additionalProperties') schemaGrammarViolations(value, `${path}.${field}`, out)
    else if ((key === 'anyOf' || key === 'oneOf') && Array.isArray(value)) value.forEach((sub, index) => schemaGrammarViolations(sub, `${path}.${field}[${index}]`, out))
    else if (key === 'enum' && Array.isArray(value) && value.some(member => typeof member !== 'string')) out.push(`Invalid value at '${path}.enum': expected a string.`)
  }
}
const draft2020 = new Ajv2020({ strict: true, allErrors: true, validateFormats: false })
function carriesAnyOf(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(carriesAnyOf)
  if (typeof schema !== 'object' || schema === null) return false
  return Object.entries(schema as Record<string, unknown>).some(([key, value]) => key === 'anyOf' || (key === 'properties' && typeof value === 'object' && value !== null ? Object.values(value as Record<string, unknown>).some(carriesAnyOf) : carriesAnyOf(value)))
}
function anthropicSchemaRefusal(body: Record<string, unknown> | undefined): string | undefined {
  const tools = (body?.request as Record<string, unknown> | undefined)?.tools
  if (!Array.isArray(tools)) return undefined
  let index = 0
  for (const tool of tools) {
    const declarations = (tool as Record<string, unknown>).functionDeclarations
    if (!Array.isArray(declarations)) continue
    for (const declaration of declarations) {
      const parameters = ((declaration as Record<string, unknown>).parameters ?? {}) as object
      let invalid = carriesAnyOf(parameters)
      if (!invalid) {
        try {
          draft2020.compile(parameters)
        } catch {
          invalid = true
        }
      }
      if (invalid) return JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `tools.${index}.custom.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12 (https://json-schema.org/draft/2020-12). Learn more about tool use at https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview.` }, request_id: 'req_vrtx_fixture' })
      index += 1
    }
  }
  return undefined
}
function declarationViolations(body: Record<string, unknown> | undefined): string[] {
  const out: string[] = []
  const tools = (body?.request as Record<string, unknown> | undefined)?.tools
  if (!Array.isArray(tools)) return out
  tools.forEach((tool, t) => {
    const declarations = (tool as Record<string, unknown>).functionDeclarations
    if (!Array.isArray(declarations)) return
    declarations.forEach((declaration, d) => schemaGrammarViolations((declaration as Record<string, unknown>).parameters, `request.tools[${t}].function_declarations[${d}].parameters`, out))
  })
  return out
}

function loadAnswer(): Record<string, unknown> {
  const project = assist.tierShape === 'onboard' && !assist.onboarded ? undefined : 'project-fixture-123'
  switch (assist.tierShape) {
    case 'paid':
      return { currentTier: PRO, paidTier: PRO, allowedTiers: [FREE, PRO], cloudaicompanionProject: project }
    case 'free':
      return { currentTier: FREE, allowedTiers: [FREE], cloudaicompanionProject: project }
    case 'licence':
      return { currentTier: { id: 'standard-tier', name: 'Gemini Code Assist Standard' }, allowedTiers: [], cloudaicompanionProject: project }
    case 'ineligible':
      return { allowedTiers: [], ineligibleTiers: [{ tierId: 'free-tier', reasonCode: 'VALIDATION_REQUIRED', reasonMessage: 'Your account needs validation before the free tier can be used.', validationUrl: 'https://example.invalid/validate' }] }
    case 'onboard':
      return assist.onboarded ? { currentTier: FREE, allowedTiers: [FREE], cloudaicompanionProject: project } : { allowedTiers: [FREE] }
  }
}

async function capture(host: 'google' | 'assist', req: Request): Promise<Capture> {
  const url = new URL(req.url)
  const entry: Capture = { host, path: url.pathname + url.search, method: req.method, headers: Object.fromEntries(req.headers.entries()) }
  if (req.method === 'POST') {
    const text = await req.text()
    if ((req.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded')) entry.form = Object.fromEntries(new URLSearchParams(text).entries())
    else {
      try { entry.body = JSON.parse(text) as Record<string, unknown> } catch { entry.body = {} }
    }
  }
  requests.push(entry)
  return entry
}

const googleServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const entry = await capture('google', req)
    if (entry.path === '/token') {
      const grant = entry.form?.grant_type
      if (grant === 'refresh_token') {
        if (google.refreshStatus !== 200) return Response.json({ error: google.refreshError ?? 'server_error' }, { status: google.refreshStatus })
        google.serial += 1
        return Response.json({ access_token: `ya29.plan-${google.serial}`, expires_in: 3600, scope: 'x', token_type: 'Bearer' })
      }
      if (google.tokenStatus !== 200) return Response.json({ error: 'invalid_grant' }, { status: google.tokenStatus })
      google.serial += 1
      return Response.json({ access_token: `ya29.plan-${google.serial}`, ...(google.withRefreshToken ? { refresh_token: `1//refresh-${google.serial}` } : {}), expires_in: 3600, scope: 'x', token_type: 'Bearer' })
    }
    if (entry.path.startsWith('/oauth2/v1/userinfo')) {
      if (google.userinfoStatus !== 200) return new Response('', { status: google.userinfoStatus })
      return Response.json({ email: google.email, verified_email: true })
    }
    return new Response('not found', { status: 404 })
  },
})
const assistServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const entry = await capture('assist', req)
    if ((entry.headers.authorization ?? '').startsWith('Bearer ya29.plan-') === false) return Response.json({ error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } }, { status: 401 })
    if (entry.path === '/v1internal:loadCodeAssist') {
      assist.loads += 1
      if (assist.loadStatus !== 200) return Response.json({ error: { code: assist.loadStatus, message: 'fixture refusal', status: 'PERMISSION_DENIED' } }, { status: assist.loadStatus })
      return Response.json(loadAnswer())
    }
    if (entry.path === '/v1internal:onboardUser') {
      assist.operationPolls = 0
      return Response.json({ name: 'operations/onboard-fixture', done: false })
    }
    if (entry.path === '/v1internal/operations/onboard-fixture') {
      assist.operationPolls += 1
      if (assist.operationPolls < assist.onboardDoneAfterPolls) return Response.json({ name: 'operations/onboard-fixture', done: false })
      assist.onboarded = true
      return Response.json({ name: 'operations/onboard-fixture', done: true, response: { '@type': 'type.googleapis.com/google.internal.cloud.code.v1internal.OnboardUserResponse', cloudaicompanionProject: { id: 'project-fixture-123' } } })
    }
    if (entry.path === '/v1internal:fetchAvailableModels') {
      assist.rosterReads += 1
      if (assist.rosterStatus !== 200) return Response.json({ error: { code: assist.rosterStatus, message: 'roster refused', status: 'PERMISSION_DENIED' } }, { status: assist.rosterStatus })
      return Response.json({ models: { ...assist.roster, ...assist.lateRows }, imageGenerationModelIds: assist.imageModelIds, agentModelSorts: [] })
    }
    if (entry.path === '/v1internal:streamGenerateContent?alt=sse') {
      const model = String(entry.body?.model ?? '')
      if (model.endsWith('-disabled')) return Response.json({ error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } }, { status: 404 })
      if (!(model in assist.roster) && !(model in assist.lateRows)) return Response.json({ error: { code: 404, message: `Model ${model} not found.`, status: 'NOT_FOUND' } }, { status: 404 })
      const violations = declarationViolations(entry.body)
      if (violations.length > 0) return Response.json({ error: { code: 400, message: violations.join('\n'), status: 'INVALID_ARGUMENT' } }, { status: 400 })
      if (!model.startsWith('gemini-')) {
        const refusal = anthropicSchemaRefusal(entry.body)
        if (refusal !== undefined) return Response.json({ error: { code: 400, message: refusal, status: 'INVALID_ARGUMENT' } }, { status: 400 })
      }
      if (assist.generateStatus !== 200) return Response.json({ error: { code: assist.generateStatus, message: assist.generateStatus === 429 ? 'Resource has been exhausted (e.g. check quota). Please retry after the reset.' : 'fixture refusal', status: assist.generateStatus === 429 ? 'RESOURCE_EXHAUSTED' : 'PERMISSION_DENIED' } }, { status: assist.generateStatus })
      if (assist.generateError) return new Response(sse({ error: assist.generateError }), { headers: { 'content-type': 'text/event-stream' } })
      assist.chatBodies.push(entry.body ?? {})
      if (assist.bareRefusals > 0) {
        assist.bareRefusals -= 1
        return Response.json({ error: { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT' } }, { status: 400 })
      }
      if (assist.detailedRefusals > 0) {
        assist.detailedRefusals -= 1
        return Response.json({ error: { code: 400, message: 'Invalid JSON payload received. Unknown name "probe" at \'request\': Cannot find field.', status: 'INVALID_ARGUMENT' } }, { status: 400 })
      }
      if (assist.inFlightRefusals > 0) {
        assist.inFlightRefusals -= 1
        return new Response([sse({ response: { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'thinking ' }] } }] } }), sse({ error: { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT' } })].join(''), { headers: { 'content-type': 'text/event-stream' } })
      }
      const chunks = [
        sse({ response: { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'OK from the ' }] } }], modelVersion: model, responseId: 'resp-1' } }),
        sse({ response: { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'plan fixture' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4, totalTokenCount: 11 } }, traceId: 'trace-1' }),
      ]
      return new Response(chunks.join(''), { headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('not found', { status: 404 })
  },
})
const sandboxServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch() {
    return new Response('sandbox fixture does not serve this proof', { status: 404 })
  },
})
const googleBase = `http://127.0.0.1:${googleServer.port}`
const assistBase = `http://127.0.0.1:${assistServer.port}`
process.env.MERCURY_GEMINI_OAUTH_TOKEN_BASE = `${googleBase}/token`
process.env.MERCURY_GEMINI_OAUTH_AUTH_BASE = `${googleBase}/auth`
process.env.MERCURY_GOOGLE_USERINFO_BASE = googleBase
process.env.MERCURY_ANTIGRAVITY_CODE_ASSIST_BASE = assistBase
process.env.MERCURY_ANTIGRAVITY_MANIFEST_BASE = 'https://example.invalid'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const accounts = await import('../../src/services/providers/gemini/geminiAccounts.ts')
const access = await import('../../src/services/providers/gemini/geminiPlanAccess.ts')
const contract = await import('../../src/services/providers/gemini/antigravityClientContract.ts')
const login = await import('../../src/services/providers/gemini/geminiLogin.ts')
const catalogue = await import('../../src/services/providers/gemini/geminiCatalogue.ts')
const callModel = await import('../../src/services/providers/gemini/geminiCallModel.ts')
const guide = await import('../../src/components/geminiConnectGuide.ts')
const slots = await import('../../src/services/providers/accountSlots.ts')
const sleep = async (): Promise<void> => {}

async function signIn(): Promise<{ flow: 'resolved' | 'rejected' | 'timed-out'; error?: string }> {
  const handles = accounts.beginGeminiPlanBrowserConnect({ skipBrowserOpen: true, loopbackPort: 0, sleep })
  await new Promise(resolve => setTimeout(resolve, 30))
  const port = handles.boundLoopbackPort()
  const state = new URL(handles.authorizeUrl).searchParams.get('state') ?? ''
  if (port === undefined) return { flow: 'timed-out', error: 'no listener' }
  const tab = await within(fetch(`http://127.0.0.1:${port}/oauth-callback?code=OK&state=${encodeURIComponent(state)}`))
  let error: string | undefined
  const flow = await within(handles.result.then(() => 'resolved' as const, (e: unknown) => { error = e instanceof Error ? e.message : String(e); return 'rejected' as const }))
  void tab
  return { flow: flow === 'timed-out' ? 'timed-out' : flow, ...(error !== undefined ? { error } : {}) }
}

try {
  console.log('── the authorize URL: Google\'s own Antigravity client, the five scopes, PKCE, offline access, the consent prompt, the loopback callback ──')
  const probe = accounts.beginGeminiPlanBrowserConnect({ skipBrowserOpen: true, loopbackPort: 0, sleep })
  const authorize = new URL(probe.authorizeUrl)
  const p = authorize.searchParams
  check('the sign-in goes to Google\'s authorize endpoint with the Antigravity client id', authorize.origin + authorize.pathname === `${googleBase}/auth` && p.get('client_id') === contract.ANTIGRAVITY_OAUTH_CLIENT_ID, probe.authorizeUrl)
  check('the five Antigravity scopes, S256 PKCE, offline access and the consent prompt ride the URL', p.get('scope') === contract.ANTIGRAVITY_OAUTH_SCOPE && p.get('code_challenge_method') === 'S256' && (p.get('code_challenge') ?? '').length > 20 && p.get('access_type') === 'offline' && p.get('prompt') === 'consent' && (p.get('state') ?? '').length > 10)
  check('the registered loopback callback is 127.0.0.1:51121/oauth-callback', p.get('redirect_uri') === 'http://127.0.0.1:51121/oauth-callback' && accounts.GEMINI_PLAN_REDIRECT_URI === 'http://127.0.0.1:51121/oauth-callback')
  probe.cancel('probe done')
  await probe.result.catch(() => undefined)

  console.log('── a paid plan: the exchange, the e-mail, loadCodeAssist, the stored grant ──')
  writeFileSync(accounts.geminiAuthPathForDisplay(), JSON.stringify({ version: 1 }), { mode: 0o600 })
  const paid = await signIn()
  check('the sign-in resolves', paid.flow === 'resolved', JSON.stringify(paid))
  const exchange = requests.find(r => r.host === 'google' && r.path === '/token')
  check('the exchange carries the Antigravity client id and secret, the code verifier and the loopback redirect', exchange?.form?.client_id === contract.ANTIGRAVITY_OAUTH_CLIENT_ID && exchange.form.client_secret === contract.ANTIGRAVITY_OAUTH_CLIENT_SECRET && (exchange.form.code_verifier ?? '').length > 20 && exchange.form.redirect_uri === 'http://127.0.0.1:51121/oauth-callback' && exchange.form.grant_type === 'authorization_code', JSON.stringify(exchange?.form))
  const loads = requests.filter(r => r.host === 'assist' && r.path === '/v1internal:loadCodeAssist')
  check('loadCodeAssist is asked with the Antigravity client metadata, the Antigravity User-Agent and the bearer', loads.length >= 1 && loads.every(r => (r.body?.metadata as Record<string, unknown>)?.ideType === 'ANTIGRAVITY' && r.headers['user-agent'] === contract.antigravityUserAgent() && (r.headers.authorization ?? '').startsWith('Bearer ya29.plan-')), JSON.stringify(loads.map(r => [r.body, r.headers['user-agent']])))
  const facts = accounts.geminiPlanFacts()
  check('the grant is stored with the project, the tier Google named, the e-mail and the read time', facts?.projectId === 'project-fixture-123' && facts.tier?.paid?.name === 'Google AI Pro' && facts.email === 'plan@example.invalid' && typeof facts.tierReadAtMs === 'number', JSON.stringify(facts))
  check('the auth file is mode 600 and holds no client secret of the operator', (statSync(accounts.geminiAuthPathForDisplay()).mode & 0o777) === 0o600 && !readFileSync(accounts.geminiAuthPathForDisplay(), 'utf8').includes(contract.ANTIGRAVITY_OAUTH_CLIENT_SECRET))
  check('the plan is the active source and its label names the tier', accounts.resolveGeminiAccount()?.kind === 'plan' && accounts.resolveGeminiAccount()?.label === 'Google sign-in (Google AI Pro)' && accounts.readPreferredGeminiSource() === 'plan', JSON.stringify(accounts.resolveGeminiAccount()))
  const receipt = await login.finishGeminiPlanConnect()
  check('the receipt names the tier, the e-mail, the active source, what rides and the roster count', receipt.receipt.includes('Google AI Pro') && receipt.receipt.includes('plan@example.invalid') && receipt.receipt.includes('the active source') && receipt.receipt.includes("Google's Code Assist endpoint under Google's own Antigravity client") && receipt.receipt.includes('8 chat model(s) on the roster'), receipt.receipt)
  const slot = slots.deriveFamilySlotGroups().flatMap(group => group.slots).find(s => s.id === 'gemini:plan')
  check('the /accounts board carries the Google sign-in slot with its e-mail and removal route', slot?.kind === 'subscription' && slot.identity.includes('Google AI Pro') && slot.signInEmail === 'plan@example.invalid' && slot.active && slot.removal.route === 'gemini-plan', JSON.stringify(slot))
  const rows = guide.geminiConnectRows(guide.liveGeminiConnectFacts())
  check('the /logins card offers Sign in with Google first, connected with the tier and the read\'s age, the key second, the own client third', rows[0]!.value === 'plan' && /^Sign in with Google — connected \(Google AI Pro, read \d+s ago\) · ↵ signs in again$/.test(rows[0]!.label) && rows[1]!.value === 'key' && rows[2]!.value === 'google', JSON.stringify(rows))

  console.log('── the tier stamp follows the usage read: served inside the floor, read again past it, never on a clock ──')
  const tierReadAt = accounts.geminiPlanFacts()?.tierReadAtMs ?? 0
  const loadCount = (): number => requests.filter(r => r.host === 'assist' && r.path === '/v1internal:loadCodeAssist').length
  const loadsBeforeServe = loadCount()
  const onShow = typeof accounts.rereadGeminiPlanTierOnShow === 'function' ? accounts.rereadGeminiPlanTierOnShow : undefined
  const tierServed = onShow === undefined ? undefined : await onShow({ now: () => tierReadAt + 10_000 })
  check('inside the minute the stored tier is served — no second loadCodeAssist', onShow !== undefined && tierServed?.tierReadAtMs === tierReadAt && loadCount() === loadsBeforeServe, JSON.stringify({ served: tierServed?.tierReadAtMs, tierReadAt, loads: loadCount() - loadsBeforeServe }))
  const sixHoursOn = tierReadAt + 6 * 3_600_000
  const tierReread = onShow === undefined ? undefined : await onShow({ now: () => sixHoursOn })
  check('past the floor the tier is read again and the stamp moves with the read (the sign-in\'s time no longer stands for the day)', tierReread?.tierReadAtMs === sixHoursOn && tierReread.tier?.paid?.name === 'Google AI Pro' && loadCount() === loadsBeforeServe + 1, JSON.stringify({ reread: tierReread?.tierReadAtMs, sixHoursOn, loads: loadCount() - loadsBeforeServe }))
  check('the usage owner asks the tier beside the quota on the one read-on-show road', readFileSync(join(import.meta.dir, '..', '..', 'src/services/providers/providerUsage.ts'), 'utf8').includes('await rereadGeminiPlanTierOnShow({'))

  console.log('── the roster is the authority: what Google names is offered, nothing else ──')
  const snapshot = await catalogue.refreshGeminiCatalogue('plan', { force: true })
  const rosterCall = requests.filter(r => r.host === 'assist' && r.path === '/v1internal:fetchAvailableModels').at(-1)
  check('fetchAvailableModels is a POST with an empty object under the Antigravity User-Agent', rosterCall?.method === 'POST' && JSON.stringify(rosterCall.body) === '{}' && rosterCall.headers['user-agent'] === contract.antigravityUserAgent())
  const ids = (snapshot?.models ?? []).map(m => m.id)
  check('the roster rows are the account\'s own, the internal row dropped, the image row kept out of chat, a Gemini id bare and every other vendor\'s id under google/', ids.length === 10 && ids.includes('gemini-4-argon') && ids.includes('google/claude-sonnet-4-6') && ids.includes('google/claude-opus-4-6-thinking') && ids.includes('google/gpt-oss-120b-medium') && ids.includes('gemini-4-helium-disabled') && !ids.includes('claude-sonnet-4-6') && !ids.includes('chat_internal') && snapshot?.models.find(m => m.id === 'gemini-3.1-flash-image')?.supportedGenerationMethods?.includes('generateImages') === true, ids.join(','))
  const availability = catalogue.getGeminiAvailability()
  check('the chat rows are every chat model Google names — Gemini, Claude and GPT-OSS alike; the image row is not one', availability.state === 'ready' && JSON.stringify(availability.ids) === JSON.stringify(['gemini-4-argon', 'gemini-3.5-flash-low', 'google/claude-sonnet-4-6', 'google/claude-opus-4-6-thinking', 'google/gpt-oss-120b-medium', 'gemini-4-neon-low', 'gemini-4-neon-medium', 'gemini-4-neon-high']) && availability.sourceKind === 'plan', JSON.stringify(availability))
  const options = catalogue.getGeminiModelOptions()
  const argon = options.find(o => o.value === 'gemini-4-argon')
  const claude = options.find(o => o.value === 'google/claude-sonnet-4-6')
  check('gemini-4-argon is selectable with its stated window; the Claude row is selectable under google/ with the roster\'s display name, its stated window, and a description naming Google\'s own id and the lane it rides', argon !== undefined && argon.unavailable === undefined && argon.statedContextWindow === 1048576 && claude !== undefined && claude.unavailable === undefined && claude.label === 'Claude Sonnet 4.6' && claude.statedContextWindow === 200000 && claude.group === argon.group && (claude.descriptionForModel ?? '').includes("Google's own id for it is claude-sonnet-4-6") && (claude.descriptionForModel ?? '').includes("never the vendor's own lane"), JSON.stringify({ argon, claude }))
  check('the stated facts: window, output ceiling and the thinking dial from the roster', catalogue.geminiContextWindowFor('gemini-4-argon')?.window === 1048576 && catalogue.geminiOutputTokenLimitFor('gemini-4-argon') === 65536 && catalogue.geminiEffortVocabularyFor('gemini-4-argon').length > 0)
  check('the roster quota rides the row', snapshot?.models.find(m => m.id === 'gemini-4-argon')?.quota?.remainingFraction === 0.8)

  console.log('── a disabled roster row: listed with its state, never offered as runnable; a bare id\'s 404 names its roster kin ──')
  const helium = options.find(o => o.value === 'gemini-4-helium-disabled')
  check('the -disabled row Google serves is listed under the Google sign-in with its state said and is not selectable; it is no chat row (not in the availability ids, not a live-listed id, not counted)', snapshot?.models.find(m => m.id === 'gemini-4-helium-disabled')?.disabled === true && helium !== undefined && helium.label === 'Gemini 4 Helium' && helium.unavailable === "withheld from Google AI Pro today — Google's roster names it gemini-4-helium-disabled (Gemini 4 Helium) and answers 404 to the id; antigravity.google/docs/models says which plans include it; not offered as runnable" && !availability.ids.includes('gemini-4-helium-disabled') && !catalogue.cachedLiveIds().has('gemini-4-helium-disabled') && catalogue.geminiGenerateModels(snapshot).length === 8, JSON.stringify({ helium, ids: availability.ids }))
  console.log('── a bare id whose roster names only effort rows rides the row of the session\'s effort (the public client\'s collapse table): low → -low, medium → -medium, high/max/xhigh/none → -high; the status row says the ride ──')
  check('the effort row law: the bare id resolves per effort, an unknown or absent effort takes high, a missing tier falls to the nearest present, an exact row or a non-Gemini id never resolves', catalogue.geminiPlanWireModel('gemini-4-neon', 'low') === 'gemini-4-neon-low' && catalogue.geminiPlanWireModel('gemini-4-neon', 'medium') === 'gemini-4-neon-medium' && catalogue.geminiPlanWireModel('gemini-4-neon', 'high') === 'gemini-4-neon-high' && catalogue.geminiPlanWireModel('gemini-4-neon', 'max') === 'gemini-4-neon-high' && catalogue.geminiPlanWireModel('gemini-4-neon', 'xhigh') === 'gemini-4-neon-high' && catalogue.geminiPlanWireModel('gemini-4-neon', undefined) === 'gemini-4-neon-high' && catalogue.geminiPlanWireModel('gemini-4-neon', 'minimal') === 'gemini-4-neon-low' && catalogue.geminiPlanWireModel('gemini-3.5-flash', 'high') === 'gemini-3.5-flash-low' && catalogue.geminiPlanWireModel('gemini-4-argon', 'low') === 'gemini-4-argon' && catalogue.geminiPlanWireModel('gemini-4-neon-high', 'low') === 'gemini-4-neon-high' && catalogue.geminiPlanWireModel('claude-sonnet-4-6', 'low') === 'claude-sonnet-4-6' && catalogue.geminiPlanWireModel('gemini-4-helium', 'high') === 'gemini-4-helium')
  const { resolveDisplayedSessionModel } = await import('../../src/hooks/useDisplayedSessionModel.ts')
  check('the status row says the ride beside the chosen id, and keeps the queued-switch grammar', resolveDisplayedSessionModel('gemini-4-neon', null, catalogue.geminiPlanRideWords('gemini-4-neon', 'medium')).compact === 'gemini-4-neon ▸ gemini-4-neon-medium' && resolveDisplayedSessionModel('gemini-4-neon', { setting: 'gemini-3.5-flash-low' }, 'gemini-4-neon-high').label === 'gemini-4-neon ▸ gemini-4-neon-high → gemini-3.5-flash-low (queued)' && resolveDisplayedSessionModel('gemini-4-argon', null, catalogue.geminiPlanRideWords('gemini-4-argon', 'high')).compact === 'gemini-4-argon', JSON.stringify(resolveDisplayedSessionModel('gemini-4-neon', null, catalogue.geminiPlanRideWords('gemini-4-neon', 'medium'))))
  check('the 404 words for the bare id name the disabled roster row with its state; a bare id with effort siblings on the roster names them', callModel.geminiPlanModelMissingWords('gemini-4-helium', 404, undefined).includes("Google serves no model 'gemini-4-helium' to this Google sign-in (HTTP 404) · the roster names gemini-4-helium-disabled (Gemini 4 Helium): withheld from Google AI Pro today, antigravity.google/docs/models says which plans include it · /model lists the roster") && callModel.geminiPlanModelMissingWords('gemini-3.5-flash', 404, undefined).includes('the roster names gemini-3.5-flash-low — /model picks one') && !callModel.geminiPlanModelMissingWords('gemini-9-nope', 404, undefined).includes('the roster names'), callModel.geminiPlanModelMissingWords('gemini-4-helium', 404, undefined))

  console.log('── the roster beyond Gemini: google/<id> rides this sign-in, never the vendor\'s lane; the flags are the capabilities ──')
  const { declaredRouteOf, canonicalWireModelId } = await import('../../src/services/providers/routeLaw.ts')
  const wire = canonicalWireModelId('google/claude-sonnet-4-6')
  check('google/claude-sonnet-4-6 routes to the Gemini family and rides the wire as Google\'s own id; the bare claude-sonnet-4-6 stays the Anthropic lane while the roster is cached', declaredRouteOf('google/claude-sonnet-4-6') === 'gemini' && declaredRouteOf('claude-sonnet-4-6') === 'anthropic' && declaredRouteOf('gpt-oss-120b-medium') === 'openai' && declaredRouteOf('google/gpt-oss-120b-medium') === 'gemini' && wire.ok && wire.wireId === 'claude-sonnet-4-6', JSON.stringify({ wire, claude: declaredRouteOf('claude-sonnet-4-6') }))
  const nested = canonicalWireModelId('google/google/claude-sonnet-4-6')
  check('a re-prefixed id is refused before any wire', !nested.ok && nested.reason.includes('nests the google/ namespace'), JSON.stringify(nested))
  check('the stated facts of a google/ row: the window, the output ceiling, the thinking dial only where the roster says so', catalogue.geminiContextWindowFor('google/claude-sonnet-4-6')?.window === 200000 && catalogue.geminiOutputTokenLimitFor('google/claude-sonnet-4-6') === 64000 && catalogue.geminiEffortVocabularyFor('google/claude-sonnet-4-6').length === 0 && catalogue.geminiEffortVocabularyFor('google/claude-opus-4-6-thinking').length > 0 && catalogue.geminiEffortVocabularyFor('google/gpt-oss-120b-medium').length > 0)
  const { modelReceivesImageBlocks } = await import('../../src/utils/model/capabilities.ts')
  check('images ride only where the roster flags them', modelReceivesImageBlocks('gemini-4-argon') === true && modelReceivesImageBlocks('gemini-3.5-flash-low') === false && modelReceivesImageBlocks('google/claude-sonnet-4-6') === false)
  const engine = await import('../../src/utils/crew/engineDispatch.ts')
  const dispatched = await engine.resolveEngineDispatch('google/claude-sonnet-4-6').catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }))
  check('a crewmate named onto google/claude-sonnet-4-6 dispatches on the Gemini backend with the roster\'s display name', 'backend' in dispatched && dispatched.backend === 'gemini' && dispatched.model === 'google/claude-sonnet-4-6' && dispatched.displayLabel === 'Claude Sonnet 4.6', JSON.stringify(dispatched))
  const { geminiValidatesSignatures, buildGeminiRequest, GEMINI_SKIP_SIGNATURE_VALIDATION } = await import('../../src/services/providers/gemini/geminiCodec.ts')
  const lostRecord = buildGeminiRequest({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', content: 'ok' }] } as never, [])
  const geminiLost = buildGeminiRequest({ model: 'gemini-4-argon', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', content: 'ok' }] } as never, [])
  check('the signed-parts law per model: the signature placeholder is Gemini 3\'s contract — a Claude history that lost its record sends none, a Gemini one sends it', geminiValidatesSignatures('claude-sonnet-4-6') === false && geminiValidatesSignatures('gemini-4-argon') === true && lostRecord.contents[1]?.parts[0]?.thoughtSignature === undefined && geminiLost.contents[1]?.parts[0]?.thoughtSignature === GEMINI_SKIP_SIGNATURE_VALIDATION)
  const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { z } = await import('zod')
  const { randomUUID } = await import('node:crypto')
  const bashTool = { name: 'Bash', prompt: async () => 'Runs a command.', inputSchema: z.object({ command: z.string() }), inputJSONSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }
  const driveRoad = async (model: string, withTools: boolean | unknown[]): Promise<Array<Record<string, unknown>>> => {
    const out: Array<Record<string, unknown>> = []
    const params = { messages: [{ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } }], systemPrompt: asSystemPrompt(['be brief']), thinkingConfig: { type: 'enabled', budget_tokens: 8192 }, tools: Array.isArray(withTools) ? withTools : withTools ? [bashTool] : [], signal: new AbortController().signal, options: { model, effortValue: 'medium', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], maxOutputTokensOverride: 100000 } }
    for await (const item of callModel.geminiCallModel(params as never)) out.push(item as Record<string, unknown>)
    return out
  }
  const neonReplies = await driveRoad('gemini-4-neon', true)
  const neonHit = requests.filter(r => r.host === 'assist' && r.path === '/v1internal:streamGenerateContent?alt=sse').at(-1)
  const neonGen = ((neonHit?.body?.request as Record<string, unknown>)?.generationConfig ?? {}) as Record<string, unknown>
  check('through the road at effort medium, /model gemini-4-neon rides gemini-4-neon-medium: the wire model is the effort row, the thinking level and the row\'s own ceiling ride, the answer lands', neonHit?.body?.model === 'gemini-4-neon-medium' && JSON.stringify(neonGen.thinkingConfig) === JSON.stringify({ thinkingLevel: 'MEDIUM' }) && neonGen.maxOutputTokens === 65536 && neonReplies.some(m => m.type === 'assistant' && !(m as { isApiErrorMessage?: boolean }).isApiErrorMessage), JSON.stringify({ model: neonHit?.body?.model, gen: neonGen }))
  const engineNeon = await (await import('../../src/utils/crew/engineDispatch.ts')).resolveEngineDispatch('gemini-4-neon').catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }))
  check('a crewmate named onto the bare id dispatches on the Gemini backend with the high row (no effort of its own)', 'backend' in engineNeon && engineNeon.backend === 'gemini' && engineNeon.model === 'gemini-4-neon-high', JSON.stringify(engineNeon))
  console.log('── the roster is re-read: on the TTL before a chat (never only at sign-in), and once on a bare id\'s 404 — a row that appeared meanwhile is taken, else the kin words ──')
  catalogue.__resetGeminiCatalogueForTest()
  const readsBeforeCold = assist.rosterReads
  const coldStart = requests.length
  const coldReplies = await driveRoad('gemini-4-neon', true)
  const coldOrder = requests.slice(coldStart).filter(r => r.host === 'assist').map(r => r.path)
  check('with no roster cached, a chat reads the roster first (one read, bounded) and then rides the effort row', assist.rosterReads === readsBeforeCold + 1 && coldOrder[0] === '/v1internal:fetchAvailableModels' && coldOrder.includes('/v1internal:streamGenerateContent?alt=sse') && requests.slice(coldStart).filter(r => r.host === 'assist' && r.path === '/v1internal:streamGenerateContent?alt=sse').at(-1)?.body?.model === 'gemini-4-neon-medium' && coldReplies.some(m => m.type === 'assistant' && !(m as { isApiErrorMessage?: boolean }).isApiErrorMessage), JSON.stringify({ reads: assist.rosterReads - readsBeforeCold, order: coldOrder }))
  const readsBeforeWarm = assist.rosterReads
  await driveRoad('gemini-4-neon', false)
  check('within the TTL the next chat reads no roster', assist.rosterReads === readsBeforeWarm)
  assist.lateRows = { 'gemini-4-xenon-high': { displayName: 'Gemini 4 Xenon', supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536 } }
  const readsBeforeLate = assist.rosterReads
  const lateStart = requests.length
  const lateReplies = await driveRoad('gemini-4-xenon', false)
  const lateChats = requests.slice(lateStart).filter(r => r.host === 'assist' && r.path === '/v1internal:streamGenerateContent?alt=sse').map(r => String(r.body?.model))
  check('a bare id the cached roster lacks: Google\'s 404, one forced roster re-read, the row that appeared meanwhile taken and the chat retried once — the answer lands, never a loop', JSON.stringify(lateChats) === JSON.stringify(['gemini-4-xenon', 'gemini-4-xenon-high']) && assist.rosterReads === readsBeforeLate + 1 && lateReplies.some(m => m.type === 'assistant' && !(m as { isApiErrorMessage?: boolean }).isApiErrorMessage) && !lateReplies.some(m => (m as { isApiErrorMessage?: boolean }).isApiErrorMessage), JSON.stringify({ chats: lateChats, reads: assist.rosterReads - readsBeforeLate, error: lateReplies.find(m => (m as { isApiErrorMessage?: boolean }).isApiErrorMessage)?.message }))
  const readsBeforeNone = assist.rosterReads
  const noneStart = requests.length
  const noneReplies = await driveRoad('gemini-9-nope', false)
  const noneChats = requests.slice(noneStart).filter(r => r.host === 'assist' && r.path === '/v1internal:streamGenerateContent?alt=sse').length
  check('a bare id no roster read brings: one chat, one re-read, then the 404 words — no retry', noneChats === 1 && assist.rosterReads === readsBeforeNone + 1 && JSON.stringify(noneReplies.find(m => (m as { isApiErrorMessage?: boolean }).isApiErrorMessage)?.message ?? '').includes("Google serves no model 'gemini-9-nope' to this Google sign-in (HTTP 404)"), JSON.stringify({ chats: noneChats, reads: assist.rosterReads - readsBeforeNone }))
  assist.lateRows = {}
  await catalogue.refreshGeminiCatalogue('plan', { force: true })

  console.log('── a long history survives: thirty signed tool rounds, a refusal row, a resume message and more rounds ride as recorded — no placeholder, no synthetic row, every call paired; a refusal in flight is retried once with plain function calling, then said ──')
  const longHistory: unknown[] = [{ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: 'Work the lane.' } }]
  const recordedTurn = (index: number, name: string, input: Record<string, unknown>): unknown => {
    const content = [{ type: 'tool_use', id: `call_${index}`, name, input }]
    const { mapMessagesToZai } = require('../../src/services/providers/zai/zaiCodec.ts') as typeof import('../../src/services/providers/zai/zaiCodec.ts')
    const projection = JSON.stringify(mapMessagesToZai(undefined, [{ role: 'assistant', content }] as never)[0])
    return { type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'assistant', content, model: 'gemini-4-neon-high' }, geminiProviderTurn: { model: 'gemini-4-neon-high', parts: [{ functionCall: { id: `call_${index}`, name, args: input }, thoughtSignature: `sig-${index}` }], calls: [{ id: `call_${index}`, name, nativeId: `call_${index}` }], projection } }
  }
  const resultRow = (index: number, body: string): unknown => ({ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call_${index}`, content: body }] } })
  for (let i = 1; i <= 29; i++) {
    longHistory.push(recordedTurn(i, i % 3 === 0 ? 'Bash' : 'Read', i % 3 === 0 ? { command: `echo ${i}` } : { file_path: `/tmp/file-${i}.ts` }))
    longHistory.push(resultRow(i, i % 3 === 0 ? `${i}` : `1\tconst value${i} = '—'\n2\texport {}`))
  }
  longHistory.push({ type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: Gemini stream failed (api-INVALID_ARGUMENT) — Request contains an invalid argument.' }], model: '<synthetic>' }, isApiErrorMessage: true })
  longHistory.push({ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: '<task-notification>resumed — carry on</task-notification>' } })
  longHistory.push(recordedTurn(30, 'Grep', { pattern: 'needle', path: '/tmp' }))
  longHistory.push(resultRow(30, 'Found 4 files'))
  const longTools = [bashTool, { name: 'Read', prompt: async () => 'Reads.', inputSchema: z.object({ file_path: z.string() }), inputJSONSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }, { name: 'Grep', prompt: async () => 'Greps.', inputSchema: z.object({ pattern: z.string(), path: z.string().optional() }), inputJSONSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } }]
  const driveHistory = async (model: string, history: unknown[]): Promise<Array<Record<string, unknown>>> => {
    const out: Array<Record<string, unknown>> = []
    const params = { messages: history, systemPrompt: asSystemPrompt(['be brief']), thinkingConfig: { type: 'enabled', budget_tokens: 8192 }, tools: longTools, signal: new AbortController().signal, options: { model, effortValue: 'high', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [] } }
    for await (const item of callModel.geminiCallModel(params as never)) out.push(item as Record<string, unknown>)
    return out
  }
  assist.chatBodies = []
  const longReplies = await driveHistory('gemini-4-neon-high', longHistory)
  const longBody = assist.chatBodies.at(-1)
  const longContents = ((longBody?.request as Record<string, unknown>)?.contents ?? []) as Array<{ role: string; parts: Array<Record<string, unknown>> }>
  const modelContents = longContents.filter(c => c.role === 'model')
  const callIds = modelContents.flatMap(c => c.parts.filter(p => p.functionCall !== undefined).map(p => (p.functionCall as Record<string, unknown>).id))
  const responseIds = longContents.flatMap(c => c.parts.filter(p => p.functionResponse !== undefined).map(p => (p.functionResponse as Record<string, unknown>).id))
  check('the thirty-round history rides as recorded: thirty model contents each with its own signature, no placeholder, the synthetic refusal row absent, every call answered once in order, the resume text beside its tool result; the answer lands', modelContents.length === 30 && modelContents.every(c => c.parts.length === 1 && typeof c.parts[0]!.thoughtSignature === 'string' && String(c.parts[0]!.thoughtSignature).startsWith('sig-')) && !JSON.stringify(longContents).includes('API Error') && !JSON.stringify(longContents).includes('skip_thought_signature_validator') && JSON.stringify(callIds) === JSON.stringify(responseIds) && callIds.length === 30 && longContents.some(c => c.role === 'user' && c.parts.some(p => p.functionResponse !== undefined) && c.parts.some(p => typeof p.text === 'string' && String(p.text).includes('task-notification'))) && longReplies.some(m => m.type === 'assistant' && !(m as { isApiErrorMessage?: boolean }).isApiErrorMessage) && !longReplies.some(m => (m as { isApiErrorMessage?: boolean }).isApiErrorMessage), JSON.stringify({ modelContents: modelContents.length, placeholders: (JSON.stringify(longContents).match(/skip_thought_signature_validator/g) ?? []).length, callIds: callIds.length, responseIds: responseIds.length, error: longReplies.find(m => (m as { isApiErrorMessage?: boolean }).isApiErrorMessage)?.message }))
  const modesOf = (): Array<string | undefined> => assist.chatBodies.map(b => ((b.request as Record<string, unknown>)?.toolConfig as Record<string, Record<string, string>> | undefined)?.functionCallingConfig?.mode)
  const errorWordsOf = (replies: Array<Record<string, unknown>>): string => JSON.stringify(replies.find(m => (m as { isApiErrorMessage?: boolean }).isApiErrorMessage)?.message ?? '')
  assist.inFlightRefusals = 1
  assist.chatBodies = []
  const inFlightOnce = await driveHistory('gemini-4-neon-high', longHistory)
  check('a refusal in flight (the stream opened, then INVALID_ARGUMENT in band) is retried with the same shape and the answer lands', JSON.stringify(modesOf()) === JSON.stringify(['VALIDATED', 'VALIDATED']) && inFlightOnce.some(m => m.type === 'assistant' && !(m as { isApiErrorMessage?: boolean }).isApiErrorMessage) && !inFlightOnce.some(m => (m as { isApiErrorMessage?: boolean }).isApiErrorMessage), JSON.stringify({ modes: modesOf(), error: errorWordsOf(inFlightOnce).slice(0, 200) }))
  assist.inFlightRefusals = 2
  assist.chatBodies = []
  const inFlightTwice = await driveHistory('gemini-4-neon-high', longHistory)
  check('two refusals in flight: the same shape twice, then plain function calling (AUTO), and the answer lands', JSON.stringify(modesOf()) === JSON.stringify(['VALIDATED', 'VALIDATED', 'AUTO']) && inFlightTwice.some(m => m.type === 'assistant' && !(m as { isApiErrorMessage?: boolean }).isApiErrorMessage) && !inFlightTwice.some(m => (m as { isApiErrorMessage?: boolean }).isApiErrorMessage), JSON.stringify({ modes: modesOf(), error: errorWordsOf(inFlightTwice).slice(0, 200) }))
  assist.inFlightRefusals = 3
  assist.chatBodies = []
  const inFlightThrice = await driveHistory('gemini-4-neon-high', longHistory)
  const thriceWords = errorWordsOf(inFlightThrice)
  check('three refusals in flight end the turn with the words that place the refusal in flight with the elapsed time and name the attempts — never a fourth', assist.chatBodies.length === 3 && /Google refused the request on 'gemini-4-neon-high' — in flight at \d+ s — the request was accepted and the refusal came while the model answered \(INVALID_ARGUMENT, no detail\); retried twice \(the same shape, then plain function calling\)/.test(thriceWords) && thriceWords.includes('/model picks another roster row'), thriceWords.slice(0, 400))
  assist.inFlightRefusals = 0
  assist.bareRefusals = 3
  assist.chatBodies = []
  const bareThrice = await driveHistory('gemini-4-neon-high', longHistory)
  const bareWords = errorWordsOf(bareThrice)
  check('a bare HTTP 400 INVALID_ARGUMENT (no detail, the live shape of 04:37) walks the same ladder — the same shape twice, then plain — and the words say HTTP 400, the elapsed time and the attempts', assist.chatBodies.length === 3 && JSON.stringify(modesOf()) === JSON.stringify(['VALIDATED', 'VALIDATED', 'AUTO']) && /Google refused the request on 'gemini-4-neon-high' — HTTP 400 after \d+ s, before any answer byte \(INVALID_ARGUMENT, no detail\); retried twice \(the same shape, then plain function calling\)/.test(bareWords), bareWords.slice(0, 400))
  assist.bareRefusals = 0
  assist.detailedRefusals = 1
  assist.chatBodies = []
  const detailed = await driveHistory('gemini-4-neon-high', longHistory)
  check('a 400 with detail is never retried: one request, the words say HTTP 400 with detail, not retried, and carry Google\'s words', assist.chatBodies.length === 1 && /Google refused the request on 'gemini-4-neon-high' — HTTP 400 after \d+ s, before any answer byte \(INVALID_ARGUMENT, with detail; not retried\)\. The wire said: api-INVALID_ARGUMENT: Invalid JSON payload received\. Unknown name \\"probe\\"/.test(errorWordsOf(detailed)), JSON.stringify({ chats: assist.chatBodies.length, words: errorWordsOf(detailed).slice(0, 300) }))
  assist.detailedRefusals = 0
  const heliumReplies = await driveRoad('gemini-4-helium', false)
  const heliumWords = JSON.stringify(heliumReplies.find(m => m.type === 'assistant' && (m as { isApiErrorMessage?: boolean }).isApiErrorMessage)?.message ?? '')
  const disabledOnTheWire = await driveRoad('gemini-4-helium-disabled', false)
  const disabledWords = JSON.stringify(disabledOnTheWire.find(m => m.type === 'assistant' && (m as { isApiErrorMessage?: boolean }).isApiErrorMessage)?.message ?? '')
  check('the -disabled id sent verbatim is Google\'s 404 (the live shape of 2026-10-14: "Requested entity was not found."), and the words name the row\'s state', disabledWords.includes("Google serves no model 'gemini-4-helium-disabled' to this Google sign-in (HTTP 404) · the roster names gemini-4-helium-disabled (Gemini 4 Helium): withheld from Google AI Pro today") && disabledWords.includes('The wire said: api-NOT_FOUND: Requested entity was not found.'), disabledWords.slice(0, 400))
  check('through the road, /model gemini-4-helium on this sign-in is Google\'s 404 naming the disabled roster row', heliumWords.includes("Google serves no model 'gemini-4-helium' to this Google sign-in (HTTP 404) · the roster names gemini-4-helium-disabled (Gemini 4 Helium): withheld from Google AI Pro today, antigravity.google/docs/models says which plans include it"), heliumWords.slice(0, 400))
  const claudeReplies = await driveRoad('google/claude-opus-4-6-thinking', true)
  const claudeHit = requests.filter(r => r.host === 'assist' && r.path === '/v1internal:streamGenerateContent?alt=sse').at(-1)
  const claudeInner = (claudeHit?.body?.request ?? {}) as Record<string, unknown>
  const claudeGen = (claudeInner.generationConfig ?? {}) as Record<string, unknown>
  check('a google/claude row rides the plan wire as Google\'s own id, labelled used_claude, with thinking as a token budget (thoughts included), function calling VALIDATED and the output ceiling capped at 64000', claudeHit?.body?.model === 'claude-opus-4-6-thinking' && (claudeHit.body.request as Record<string, unknown>) !== undefined && ((claudeHit.body.request as Record<string, Record<string, string>>).labels.used_claude === 'true') && JSON.stringify(claudeGen.thinkingConfig) === JSON.stringify({ includeThoughts: true, thinkingBudget: 8192 }) && claudeGen.maxOutputTokens === 64000 && (claudeInner.toolConfig as Record<string, Record<string, string>>)?.functionCallingConfig?.mode === 'VALIDATED' && claudeReplies.some(m => m.type === 'assistant' && JSON.stringify((m.message as Record<string, unknown>).content).includes('OK from the plan fixture')), JSON.stringify({ model: claudeHit?.body?.model, labels: (claudeHit?.body?.request as Record<string, unknown>)?.labels, gen: claudeGen, toolConfig: claudeInner.toolConfig }))
  await driveRoad('google/claude-sonnet-4-6', false)
  const bareClaudeHit = requests.filter(r => r.host === 'assist' && r.path === '/v1internal:streamGenerateContent?alt=sse').at(-1)
  const bareInner = (bareClaudeHit?.body?.request ?? {}) as Record<string, unknown>
  check('a Claude row with no tools still sends VALIDATED function calling and no thinking budget where the roster states no thinking', bareClaudeHit?.body?.model === 'claude-sonnet-4-6' && (bareInner.toolConfig as Record<string, Record<string, string>>)?.functionCallingConfig?.mode === 'VALIDATED' && (bareInner.generationConfig as Record<string, unknown> | undefined)?.thinkingConfig === undefined, JSON.stringify(bareInner))
  await driveRoad('gemini-4-argon', true)
  const argonHit = requests.filter(r => r.host === 'assist' && r.path === '/v1internal:streamGenerateContent?alt=sse').at(-1)
  const argonGen = ((argonHit?.body?.request as Record<string, unknown>)?.generationConfig ?? {}) as Record<string, unknown>
  check('a Gemini row on the same wire keeps its own shape: used_claude false, the thinking level, and the output ceiling is the roster\'s own (a caller\'s larger ask is clamped to it)', argonHit?.body?.model === 'gemini-4-argon' && (argonHit.body.request as Record<string, Record<string, string>>).labels.used_claude === 'false' && JSON.stringify(argonGen.thinkingConfig) === JSON.stringify({ thinkingLevel: 'MEDIUM' }) && argonGen.maxOutputTokens === 65536, JSON.stringify({ labels: (argonHit?.body?.request as Record<string, unknown>)?.labels, gen: argonGen }))
  const { streamGeminiContent: streamPlain } = await import('../../src/services/providers/gemini/geminiClient.ts')
  const planAuth = await accounts.resolveGeminiRequestAuth({ sourceKind: 'plan' })
  for await (const _event of streamPlain({ apiKey: planAuth!.headers.authorization!.slice(7), url: `${assistBase}/v1internal:streamGenerateContent?alt=sse`, request: { model: 'gemini-3.5-flash-low', messages: [{ role: 'user', content: 'hi' }] } as never, messages: [], plan: { ...callModel.nextGeminiPlanEnvelope('project-fixture-123', 'gemini-3.5-flash-low'), bases: [assistBase], userAgent: planAuth!.headers['user-agent']! }, onTurn: () => {} })) void _event
  const noAskHit = requests.filter(r => r.host === 'assist' && r.path === '/v1internal:streamGenerateContent?alt=sse').at(-1)
  check('with no ceiling asked, the wire carries none — the generation config is Google\'s own default', ((noAskHit?.body?.request as Record<string, unknown>)?.generationConfig) === undefined, JSON.stringify((noAskHit?.body?.request as Record<string, unknown>)?.generationConfig))
  await driveRoad('gemini-3.5-flash-low', false)
  const roadHit = requests.filter(r => r.host === 'assist' && r.path === '/v1internal:streamGenerateContent?alt=sse').at(-1)
  check('through the road a Gemini row gets the roster\'s own ceiling as its output ceiling — room to finish, never more than Google states', (((roadHit?.body?.request as Record<string, unknown>)?.generationConfig ?? {}) as Record<string, unknown>).maxOutputTokens === 65536, JSON.stringify((roadHit?.body?.request as Record<string, unknown>)?.generationConfig))
  check('the 404 for a roster id Google does not serve names the id as the user spelled it', callModel.geminiPlanModelMissingWords('google/gpt-oss-120b-medium', 404, undefined).includes("Google serves no model 'google/gpt-oss-120b-medium' to this Google sign-in (HTTP 404)"))
  const { usageForProvider } = await import('../../src/services/providers/providerUsage.ts')
  const owner = usageForProvider('gemini')
  const tierFigure = owner.figures?.find(f => f.key === 'plan-tier')
  const quotaFigure = owner.figures?.find(f => f.key === 'plan-quota:gemini-4-argon')
  check('/usage states the tier Google reports with the read\'s stamp, the roster quota per model with its reset, and the honest absence line', owner.tier === 'Google AI Pro' && tierFigure?.value === 'Google AI Pro' && typeof tierFigure.observedAtMs === 'number' && quotaFigure?.value === '80%' && quotaFigure.resetsAtMs === Date.parse('2026-10-15T00:00:00Z') && (owner.absence ?? '').includes('no spend or credit figure for a Google sign-in'), JSON.stringify({ tier: owner.tier, figures: owner.figures, absence: owner.absence }))

  console.log('── the usage meter for a Google sign-in: the active model first, then the models this session used, then one folded line for the rest ──')
  {
    const wide: Record<string, Record<string, unknown>> = {}
    for (let i = 1; i <= 23; i++) wide[`gemini-5-row${i}-high`] = { displayName: `Gemini 5 Row ${i}`, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, quotaInfo: { remainingFraction: 1 - i / 100, resetTime: '2026-10-15T00:00:00Z' } }
    const saved = assist.roster
    assist.roster = { ...saved, 'gemini-4-argon-low': { displayName: 'Gemini 4 Argon', supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, quotaInfo: { remainingFraction: 0.91, resetTime: '2026-10-15T00:00:00Z' } }, 'gemini-4-argon-high': { displayName: 'Gemini 4 Argon', supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, quotaInfo: { remainingFraction: 0.42, resetTime: '2026-10-15T00:00:00Z' } }, 'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash', supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, quotaInfo: { remainingFraction: 0.77, resetTime: '2026-10-15T00:00:00Z' } }, 'claude-opus-4-6-thinking': { ...saved['claude-opus-4-6-thinking'], quotaInfo: { remainingFraction: 0.99, resetTime: '2026-10-15T00:00:00Z' } }, ...wide }
    delete assist.roster['gemini-4-argon']
    await catalogue.refreshGeminiCatalogue('plan', { force: true })
    const { geminiPlanQuotaView, geminiLaneModelsByLastUse, geminiPlanQuotaFoldWords, geminiPlanUsageFigures } = await import('../../src/services/providers/providerUsage.ts')
    const figures = geminiPlanUsageFigures(accounts.geminiPlanFacts()!)
    const quotaFigures = figures.filter(f => f.key.startsWith('plan-quota:'))
    check('the fixture roster carries 27 quota rows (the owner\'s 27-line slot)', quotaFigures.length === 27, String(quotaFigures.length))
    const ledger = { 'claude-opus-4-8': { lastUsedAtMs: 50 }, 'gemini-3.8-flash': { lastUsedAtMs: 30 }, 'google/claude-opus-4-6-thinking': { lastUsedAtMs: 20 }, 'gemini-4-argon': { lastUsedAtMs: 10 } }
    const usedModels = geminiLaneModelsByLastUse(ledger)
    check('the session\'s gemini-lane models come in order of last use, the other lanes\' models left out', JSON.stringify(usedModels) === JSON.stringify(['gemini-3.8-flash', 'google/claude-opus-4-6-thinking', 'gemini-4-argon']), JSON.stringify(usedModels))
    const view = geminiPlanQuotaView(figures, { model: 'gemini-4-argon', effort: 'high', usedModels })
    check('the active model (the session\'s id resolved to its effort row) comes first with its quota and reset; then the models used this session in order of last use (the active one not repeated, a used Claude row by its google/ id, a used bare id by its effort row); then the rest folded', view.activeRow === 'gemini-4-argon-high' && view.active?.value === '42%' && view.active.resetsAtMs === Date.parse('2026-10-15T00:00:00Z') && JSON.stringify(view.used.map(f => f.key)) === JSON.stringify(['plan-quota:gemini-3.8-flash-high', 'plan-quota:google/claude-opus-4-6-thinking']) && view.others.length === 24 && view.others.every(f => !['plan-quota:gemini-4-argon-high', 'plan-quota:gemini-3.8-flash-high', 'plan-quota:google/claude-opus-4-6-thinking'].includes(f.key)), JSON.stringify({ activeRow: view.activeRow, active: view.active?.value, used: view.used.map(f => f.key), others: view.others.length }))
    check('the fold line counts the rest and says what ↵ does', geminiPlanQuotaFoldWords(24, false) === '24 other roster models — ↵ lists them' && geminiPlanQuotaFoldWords(24, true) === '24 other roster models — ↵ folds them' && geminiPlanQuotaFoldWords(1, false) === '1 other roster model — ↵ lists them')
    const noSession = geminiPlanQuotaView(figures, { usedModels: [] })
    check('with no session model and nothing used, every row folds and nothing is called active', noSession.active === undefined && noSession.used.length === 0 && noSession.others.length === 27)
    const { geminiPlanActiveQuotaWords } = await import('../../src/components/Settings/usageLine.ts')
    check('the popup header and the /logins row carry the active row\'s quota in one spelling', geminiPlanActiveQuotaWords(figures, { model: 'gemini-4-argon', effort: 'high', usedModels }) === 'gemini-4-argon-high 42% left' && geminiPlanActiveQuotaWords(figures, { usedModels: [] }) === undefined)
    const rowWithQuota = guide.geminiPlanRowLabel({ oauthConnected: false, planConnected: true, planTier: 'Google AI Pro', planActiveQuota: 'gemini-4-argon-high 42% left', active: 'plan' })
    check('the /logins row names the tier and the active row\'s quota; an inactive plan row carries no figure', rowWithQuota === 'Sign in with Google — connected (Google AI Pro) · gemini-4-argon-high 42% left · ↵ signs in again' && guide.geminiPlanRowLabel({ oauthConnected: false, keySource: 'stored', planConnected: true, planTier: 'Google AI Pro', planActiveQuota: 'gemini-4-argon-high 42% left', active: 'api-key' }) === 'Sign in with Google — connected (Google AI Pro), not active · ↵ makes it active', rowWithQuota)
    assist.roster = saved
    await catalogue.refreshGeminiCatalogue('plan', { force: true })
  }

  console.log('── the wire: the envelope, the User-Agent, the stream unwrapped, signed parts kept ──')
  const { streamGeminiContent } = await import('../../src/services/providers/gemini/geminiClient.ts')
  const auth = await accounts.resolveGeminiRequestAuth({ sourceKind: 'plan' })
  check('the request auth carries the bearer, the Antigravity User-Agent, the project and the two bases', auth?.plan?.projectId === 'project-fixture-123' && auth.headers['user-agent'] === contract.antigravityUserAgent() && auth.plan.bases.length === 1 && auth.plan.bases[0] === assistBase, JSON.stringify(auth?.plan))
  const envelope = callModel.nextGeminiPlanEnvelope('project-fixture-123')
  const events: unknown[] = []
  for await (const event of streamGeminiContent({
    apiKey: auth!.headers.authorization!.slice(7),
    url: `${assistBase}/v1internal:streamGenerateContent?alt=sse`,
    request: { model: 'gemini-4-argon', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hello' }], tools: [{ type: 'function', function: { name: 'read_file', description: 'reads', parameters: { type: 'object', properties: { path: { type: 'string', pattern: '^/' } }, required: ['path'], additionalProperties: false, $schema: 'http://json-schema.org/draft-07/schema#' } } }] } as never,
    messages: [],
    plan: { ...envelope, bases: [assistBase], userAgent: auth!.headers['user-agent']! },
    onTurn: () => {},
  })) events.push(event)
  const generate = requests.filter(r => r.host === 'assist' && r.path === '/v1internal:streamGenerateContent?alt=sse').at(-1)
  const body = generate?.body ?? {}
  const inner = body.request as Record<string, unknown>
  check('the envelope wraps the request with the project, the model, a structured request id, the Antigravity user agent and request type', body.project === 'project-fixture-123' && body.model === 'gemini-4-argon' && /^agent\/[0-9a-f-]+\/\d+\/[0-9a-f-]+\/\d+$/.test(String(body.requestId)) && body.userAgent === 'antigravity' && body.requestType === 'agent', JSON.stringify(body))
  check('the inner request carries the contents, the system instruction as role user, a session id and the labels', Array.isArray(inner.contents) && (inner.systemInstruction as Record<string, unknown>)?.role === 'user' && typeof inner.sessionId === 'string' && typeof (inner.labels as Record<string, unknown>)?.trajectory_id === 'string', JSON.stringify(inner))
  const declaration = ((inner.tools as Array<Record<string, unknown>>)[0]!.functionDeclarations as Array<Record<string, unknown>>)[0]!
  check('tools ride as parameters with the keys the Code Assist proto refuses stripped, and the function calling mode VALIDATED', declaration.parameters !== undefined && declaration.parametersJsonSchema === undefined && !JSON.stringify(declaration.parameters).includes('$schema') && JSON.stringify(declaration.parameters).includes('pattern') && (inner.toolConfig as Record<string, Record<string, unknown>>)?.functionCallingConfig?.mode === 'VALIDATED', JSON.stringify(declaration))

  console.log('── the schema grammar: every real tool definition rides the plan wire inside Google\'s Schema grammar; the fixture refuses anything outside it in Google\'s words ──')
  const { codeAssistSchema, GEMINI_SCHEMA_GRAMMAR } = await import('../../src/services/providers/gemini/geminiCodec.ts')
  const corpus = JSON.parse(readFileSync(new URL('../tool-economy/fixtures/definition-corpus.json', import.meta.url), 'utf8')) as { definitions: Array<{ name: string; description: string; input_schema: Record<string, unknown> }> }
  check('the corpus is the product\'s own: 60 definitions, the same file the tool-economy parity proof keeps byte-identical to the live tools', corpus.definitions.length === 60 && corpus.definitions.some(d => d.name === 'Bash') && JSON.stringify(corpus.definitions).includes('"const"') && JSON.stringify(corpus.definitions).includes('"exclusiveMinimum"'))
  const rawViolations: string[] = []
  corpus.definitions.forEach((d, i) => schemaGrammarViolations(d.input_schema, `request.tools[0].function_declarations[${i}].parameters`, rawViolations))
  check('unreduced, the corpus carries keywords outside the grammar — const and exclusiveMinimum among them (the owner\'s live refusal)', rawViolations.some(v => v.includes('Unknown name "const"')) && rawViolations.some(v => v.includes('Unknown name "exclusiveMinimum"')), rawViolations.slice(0, 3).join(' | '))
  const corpusTools = corpus.definitions.map(d => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.input_schema } }))
  const corpusEvents: Array<Record<string, unknown>> = []
  const corpusAuth = await accounts.resolveGeminiRequestAuth({ sourceKind: 'plan' })
  for await (const event of streamGeminiContent({ apiKey: corpusAuth!.headers.authorization!.slice(7), url: `${assistBase}/v1internal:streamGenerateContent?alt=sse`, request: { model: 'gemini-4-argon', messages: [{ role: 'user', content: 'hello' }], tools: corpusTools } as never, messages: [], plan: { ...callModel.nextGeminiPlanEnvelope('project-fixture-123', 'gemini-4-argon'), bases: [assistBase], userAgent: corpusAuth!.headers['user-agent']! }, onTurn: () => {} })) corpusEvents.push(event as Record<string, unknown>)
  const corpusHit = requests.filter(r => r.host === 'assist' && r.path === '/v1internal:streamGenerateContent?alt=sse').at(-1)
  const sentDeclarations = (((corpusHit?.body?.request as Record<string, unknown>)?.tools as Array<Record<string, unknown>>)?.[0]?.functionDeclarations ?? []) as Array<Record<string, unknown>>
  const sentViolations = declarationViolations(corpusHit?.body)
  check('all 60 real definitions ride the plan wire and Google\'s grammar accepts every one — the answer lands, no refusal', sentDeclarations.length === 60 && sentViolations.length === 0 && corpusEvents.some(e => e.type === 'finish') && !corpusEvents.some(e => e.type === 'stream-fault'), JSON.stringify({ sent: sentDeclarations.length, violations: sentViolations.slice(0, 3), fault: corpusEvents.find(e => e.type === 'stream-fault') }))
  const sentText = JSON.stringify(sentDeclarations)
  check('no declaration on the wire carries a keyword outside Google\'s Schema grammar', ['const', 'exclusiveMinimum', 'exclusiveMaximum', 'propertyNames', '$schema', 'examples', 'multipleOf', 'uniqueItems', 'allOf'].every(key => !sentText.includes(`"${key}":`)), sentText.slice(0, 200))
  const bashSent = sentDeclarations.find(d => d.name === 'Bash')
  const bashBudget = ((bashSent?.parameters as Record<string, unknown>)?.properties as Record<string, Record<string, unknown>>)?.max_output_chars
  check('a real tool\'s exclusiveMinimum is reduced: the bound rides the property\'s description in words, minimum/maximum stay as Google accepts them', bashBudget !== undefined && bashBudget.exclusiveMinimum === undefined && String(bashBudget.description).includes('greater than 0') && bashBudget.maximum === 9007199254740991 && bashBudget.type === 'integer', JSON.stringify(bashBudget))
  const constOwner = corpus.definitions.find(d => JSON.stringify(d.input_schema).includes('"const":"worktree"'))
  const constSent = sentDeclarations.find(d => d.name === constOwner?.name)
  check('a real tool\'s const is reduced to a one-member enum, the meaning kept', constOwner !== undefined && constSent !== undefined && !JSON.stringify(constSent).includes('"const"') && JSON.stringify(constSent).includes('"enum":["worktree"]'), JSON.stringify(constSent).slice(0, 300))
  const reducedUnit = codeAssistSchema({ type: 'object', properties: { kind: { const: 'log' }, n: { type: 'integer', exclusiveMinimum: 0, exclusiveMaximum: 10, multipleOf: 2, description: 'a count' }, tags: { type: 'array', items: { type: 'string' }, uniqueItems: true }, mode: { type: ['string', 'null'], enum: ['a', 'b'] }, note: { type: 'string', examples: ['x'], deprecated: true, $comment: 'c' } }, required: ['kind'], additionalProperties: false, $schema: 'http://json-schema.org/draft-07/schema#' }) as Record<string, Record<string, Record<string, unknown>>>
  check('the reducer: const → enum (type string inferred), exclusive bounds and multipleOf and uniqueItems become words, a null type becomes nullable, examples → example, annotations and meta keys drop, additionalProperties false stays', JSON.stringify(reducedUnit.properties.kind) === JSON.stringify({ enum: ['log'], type: 'string' }) && JSON.stringify(reducedUnit.properties.n) === JSON.stringify({ type: 'integer', description: 'a count. (greater than 0; less than 10; a multiple of 2)' }) && JSON.stringify(reducedUnit.properties.tags) === JSON.stringify({ type: 'array', items: { type: 'string' }, description: '(items are unique)' }) && JSON.stringify(reducedUnit.properties.mode) === JSON.stringify({ type: 'string', nullable: true, enum: ['a', 'b'] }) && JSON.stringify(reducedUnit.properties.note) === JSON.stringify({ type: 'string', example: 'x' }) && (reducedUnit as Record<string, unknown>).additionalProperties === false && (reducedUnit as Record<string, unknown>).$schema === undefined, JSON.stringify(reducedUnit))
  const unitViolations: string[] = []
  schemaGrammarViolations(reducedUnit, 'request.tools[0].function_declarations[0].parameters', unitViolations)
  check('the reduced shape is inside the grammar the fixture enforces, and the grammar is Google\'s Schema (content.proto) plus the two keys Code Assist accepted live', unitViolations.length === 0 && GEMINI_SCHEMA_GRAMMAR.size === 24 && GEMINI_SCHEMA_GRAMMAR.has('propertyOrdering') && GEMINI_SCHEMA_GRAMMAR.has('additionalProperties') && GEMINI_SCHEMA_GRAMMAR.has('oneOf') && !GEMINI_SCHEMA_GRAMMAR.has('const'), unitViolations.join(' | '))
  const rawRefusal = await fetch(`${assistBase}/v1internal:streamGenerateContent?alt=sse`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: corpusAuth!.headers.authorization!, 'user-agent': corpusAuth!.headers['user-agent']! }, body: JSON.stringify({ model: 'gemini-4-argon', project: 'project-fixture-123', request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], tools: [{ functionDeclarations: [{ name: 'Probe', parameters: { type: 'object', properties: { kind: { const: 'log' }, n: { type: 'integer', exclusiveMinimum: 0 } } } }] }] } }) })
  const rawRefusalBody = await rawRefusal.json() as { error: { message: string; status: string } }
  check('the fixture refuses an unreduced declaration in Google\'s words, naming the keyword and the proto path — the guard is real', rawRefusal.status === 400 && rawRefusalBody.error.status === 'INVALID_ARGUMENT' && rawRefusalBody.error.message.includes(`Invalid JSON payload received. Unknown name "const" at 'request.tools[0].function_declarations[0].parameters.properties[0].value': Cannot find field.`) && rawRefusalBody.error.message.includes(`Unknown name "exclusiveMinimum" at 'request.tools[0].function_declarations[0].parameters.properties[1].value'`), JSON.stringify(rawRefusalBody))

  console.log('── the schema law per row: a Claude or GPT-OSS row on Code Assist takes the subset Google\'s own client sends for it, validated as draft 2020-12 behind Code Assist ──')
  const { CODE_ASSIST_SUBSET_GRAMMAR, codeAssistGrammarFor } = await import('../../src/services/providers/gemini/geminiCodec.ts')
  check('the grammar is chosen by the wire id: a gemini-* id takes Google\'s Schema grammar, any other vendor\'s id the Code Assist subset (type, title, description, enum, items, properties, required, oneOf, default — anyOf is spelled oneOf, the shape the Anthropic side behind Code Assist accepts)', codeAssistGrammarFor('gemini-4-argon') === GEMINI_SCHEMA_GRAMMAR && codeAssistGrammarFor('claude-opus-4-6-thinking') === CODE_ASSIST_SUBSET_GRAMMAR && codeAssistGrammarFor('gpt-oss-120b-medium') === CODE_ASSIST_SUBSET_GRAMMAR && [...CODE_ASSIST_SUBSET_GRAMMAR].join(',') === 'type,title,description,enum,items,properties,required,oneOf,default')
  const captured = { type: 'object', properties: { readiness: { type: 'array', items: { anyOf: [{ type: 'object', properties: { kind: { type: 'string', enum: ['log'] }, regex: { type: 'string' } }, required: ['kind', 'regex'] }, { type: 'object', properties: { kind: { type: 'string', enum: ['tcp'] }, port: { type: 'integer' } }, required: ['kind', 'port'] }] } } } }
  const capturedRefusal = anthropicSchemaRefusal({ request: { tools: [{ functionDeclarations: [{ name: 'Probe', parameters: captured }] }] } })
  const spelled = codeAssistSchema(captured, CODE_ASSIST_SUBSET_GRAMMAR) as { properties: { readiness: { items: Record<string, unknown> } } }
  check('the captured shape (Service\'s readiness.items.anyOf, refused live on 2026-10-14 as tools.22 — req_vrtx_011Cg1TSS1U4jLBEkGqRYfMF, and alone as tools.0 with and without a type — req_vrtx_011Cg1TZn2SWD3bLPo…, …TZoXy1Fx9Woa…) is refused by the fixture as Anthropic refused it, and the reducer spells it oneOf — the shape accepted live (items.oneOf and the merged object both HTTP 200)', capturedRefusal !== undefined && capturedRefusal.includes('tools.0.custom.input_schema') && spelled.properties.readiness.items.anyOf === undefined && Array.isArray(spelled.properties.readiness.items.oneOf) && (spelled.properties.readiness.items.oneOf as unknown[]).length === 2 && anthropicSchemaRefusal({ request: { tools: [{ functionDeclarations: [{ name: 'Probe', parameters: spelled }] }] } }) === undefined, JSON.stringify({ capturedRefusal: capturedRefusal?.slice(0, 80), spelled }))
  const corpusToolsForRoad = corpus.definitions.map(d => ({ name: d.name, prompt: async () => d.description, inputSchema: undefined, inputJSONSchema: d.input_schema }))
  const claudeCorpusReplies = await driveRoad('google/claude-opus-4-6-thinking', corpusToolsForRoad)
  const claudeCorpusHit = requests.filter(r => r.host === 'assist' && r.path === '/v1internal:streamGenerateContent?alt=sse').at(-1)
  const claudeDeclarations = (((claudeCorpusHit?.body?.request as Record<string, unknown>)?.tools as Array<Record<string, unknown>>)?.[0]?.functionDeclarations ?? []) as Array<Record<string, unknown>>
  const claudeKeys = new Set<string>()
  const collectKeys = (schema: unknown): void => {
    if (Array.isArray(schema)) { schema.forEach(collectKeys); return }
    if (typeof schema !== 'object' || schema === null) return
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      claudeKeys.add(key)
      if (key === 'properties') Object.values(value as Record<string, unknown>).forEach(collectKeys)
      else if (key === 'items' || key === 'anyOf' || key === 'oneOf' || key === 'additionalProperties') collectKeys(value)
    }
  }
  claudeDeclarations.forEach(d => collectKeys(d.parameters))
  check(`the real definitions ride to a Claude row (${claudeDeclarations.length} of 60 — the road's own assembly keeps ToolSearch for itself) and both gates accept them — the proto grammar and the draft-2020-12 validation behind Code Assist; the answer lands`, claudeCorpusHit?.body?.model === 'claude-opus-4-6-thinking' && claudeDeclarations.length >= 58 && corpus.definitions.filter(d => !claudeDeclarations.some(sent => sent.name === d.name)).every(d => d.name === 'ToolSearch') && anthropicSchemaRefusal(claudeCorpusHit.body) === undefined && claudeCorpusReplies.some(m => m.type === 'assistant' && !(m as { isApiErrorMessage?: boolean }).isApiErrorMessage) && !claudeCorpusReplies.some(m => (m as { isApiErrorMessage?: boolean }).isApiErrorMessage), JSON.stringify({ model: claudeCorpusHit?.body?.model, declarations: claudeDeclarations.length, missing: corpus.definitions.filter(d => !claudeDeclarations.some(sent => sent.name === d.name)).map(d => d.name), refusal: anthropicSchemaRefusal(claudeCorpusHit?.body)?.slice(0, 200), replies: claudeCorpusReplies.map(m => [m.type, (m as { isApiErrorMessage?: boolean }).isApiErrorMessage, String(JSON.stringify((m as { message?: unknown }).message ?? m)).slice(0, 160)]) }))
  check('on the Claude row every declaration stays inside the subset: no anyOf, no minimum/maximum/minItems/maxItems/minLength/maxLength/pattern/format/additionalProperties/nullable/example on the wire; Service\'s readiness rides as items.oneOf', [...claudeKeys].every(key => CODE_ASSIST_SUBSET_GRAMMAR.has(key)) && !claudeKeys.has('anyOf') && Array.isArray((((claudeDeclarations.find(d => d.name === 'Service')?.parameters as Record<string, unknown>)?.properties as Record<string, Record<string, Record<string, unknown>>>)?.readiness?.items as Record<string, unknown>)?.oneOf), [...claudeKeys].filter(key => !CODE_ASSIST_SUBSET_GRAMMAR.has(key)).join(','))
  const askSent = claudeDeclarations.find(d => d.name === 'AskUserQuestion')
  const askRaw = corpus.definitions.find(d => d.name === 'AskUserQuestion')!.input_schema as { properties: { questions: { minItems: number; maxItems: number; description?: string } } }
  const askQuestions = ((askSent?.parameters as Record<string, unknown>)?.properties as Record<string, Record<string, unknown>>)?.questions
  check('a real tool\'s bounds ride the Claude row as words: AskUserQuestion\'s questions array says its item bounds in its description, minItems/maxItems gone', askQuestions !== undefined && askQuestions.minItems === undefined && askQuestions.maxItems === undefined && String(askQuestions.description).includes(`at least ${askRaw.properties.questions.minItems} item`) && String(askQuestions.description).includes(`at most ${askRaw.properties.questions.maxItems} item`), JSON.stringify(askQuestions))
  const bashClaude = ((claudeDeclarations.find(d => d.name === 'Bash')?.parameters as Record<string, unknown>)?.properties as Record<string, Record<string, unknown>>)?.max_output_chars
  check('the same Bash property on the Claude row: maximum becomes words too, the exclusive bound stays words, the type stays', bashClaude !== undefined && bashClaude.maximum === undefined && String(bashClaude.description).includes('greater than 0') && String(bashClaude.description).includes('at most 9007199254740991') && bashClaude.type === 'integer', JSON.stringify(bashClaude))
  const ossReplies = await driveRoad('google/gpt-oss-120b-medium', true)
  const ossHit = requests.filter(r => r.host === 'assist' && r.path === '/v1internal:streamGenerateContent?alt=sse').at(-1)
  const ossDeclaration = (((ossHit?.body?.request as Record<string, unknown>)?.tools as Array<Record<string, unknown>>)?.[0]?.functionDeclarations ?? [])[0] as Record<string, unknown> | undefined
  check('a GPT-OSS row takes the subset as well and answers', ossHit?.body?.model === 'gpt-oss-120b-medium' && ossDeclaration !== undefined && JSON.stringify(ossDeclaration.parameters) === JSON.stringify({ type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }) && ossReplies.some(m => m.type === 'assistant' && !(m as { isApiErrorMessage?: boolean }).isApiErrorMessage), JSON.stringify(ossDeclaration))
  const argonCorpusReplies = await driveRoad('gemini-4-argon', corpusToolsForRoad)
  const argonCorpusHit = requests.filter(r => r.host === 'assist' && r.path === '/v1internal:streamGenerateContent?alt=sse').at(-1)
  const argonBash = (((((argonCorpusHit?.body?.request as Record<string, unknown>)?.tools as Array<Record<string, unknown>>)?.[0]?.functionDeclarations ?? []) as Array<Record<string, unknown>>).find(d => d.name === 'Bash')?.parameters as Record<string, unknown>)?.properties as Record<string, Record<string, unknown>>
  check('the Gemini row keeps Google\'s fuller grammar for the same corpus: Bash\'s maximum rides as a number and the answer lands', argonCorpusHit?.body?.model === 'gemini-4-argon' && argonBash?.max_output_chars?.maximum === 9007199254740991 && argonCorpusReplies.some(m => m.type === 'assistant' && !(m as { isApiErrorMessage?: boolean }).isApiErrorMessage), JSON.stringify(argonBash?.max_output_chars))
  const claudeRawRefusal = await fetch(`${assistBase}/v1internal:streamGenerateContent?alt=sse`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: corpusAuth!.headers.authorization!, 'user-agent': corpusAuth!.headers['user-agent']! }, body: JSON.stringify({ model: 'claude-opus-4-6-thinking', project: 'project-fixture-123', request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], tools: [{ functionDeclarations: [{ name: 'Fine', parameters: { type: 'object', properties: { a: { type: 'string' } } } }, { name: 'Probe', parameters: { type: 'object', properties: { mode: { type: 'string', propertyOrdering: ['a'] } } } }] }] } }) })
  const claudeRawBody = claudeRawRefusal.status === 400 ? await claudeRawRefusal.json() as { error: { message: string; status: string } } : { error: { message: await claudeRawRefusal.text(), status: String(claudeRawRefusal.status) } }
  check('the fixture refuses, for a Claude row, a declaration carrying a key outside draft 2020-12 (propertyOrdering — Google\'s grammar, not Anthropic\'s) in Anthropic\'s words relayed by Code Assist, naming the tool index — the guard is real', claudeRawRefusal.status === 400 && claudeRawBody.error.status === 'INVALID_ARGUMENT' && claudeRawBody.error.message.includes('"message":"tools.1.custom.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12') && claudeRawBody.error.message.includes('"request_id"'), JSON.stringify(claudeRawBody))
  check('the request goes out under the Antigravity User-Agent with the bearer', generate?.headers['user-agent'] === contract.antigravityUserAgent() && (generate.headers.authorization ?? '').startsWith('Bearer ya29.plan-'))
  const text = events.filter(e => (e as { type: string }).type === 'text-delta').map(e => (e as { text: string }).text).join('')
  const finish = events.find(e => (e as { type: string }).type === 'finish') as { reason?: string } | undefined
  const usage = events.find(e => (e as { type: string }).type === 'usage') as { usage?: { inputTokens: number } } | undefined
  check('the wrapped stream is unwrapped: the text, the finish reason and the usage land', text === 'OK from the plan fixture' && finish?.reason === 'stop' && usage?.usage?.inputTokens === 7, JSON.stringify(events))

  console.log('── the refresh keeps the project; a dead refresh token drops the sign-in and says so ──')
  accounts.__resetGeminiAccountsForTest()
  const before = JSON.parse(readFileSync(accounts.geminiAuthPathForDisplay(), 'utf8')) as { plan: { tokens: { accessToken: string; refreshToken: string; accessTokenExpiresAtMs: number } } }
  before.plan.tokens.accessTokenExpiresAtMs = Date.now() - 1000
  writeFileSync(accounts.geminiAuthPathForDisplay(), JSON.stringify(before), { mode: 0o600 })
  const refreshed = await accounts.currentGeminiPlanTokens()
  const refreshCall = requests.filter(r => r.host === 'google' && r.path === '/token' && r.form?.grant_type === 'refresh_token').at(-1)
  check('an expired access token is refreshed with the Antigravity client, the refresh token carried forward', refreshed?.accessToken !== before.plan.tokens.accessToken && refreshed?.refreshToken === before.plan.tokens.refreshToken && refreshCall?.form?.client_id === contract.ANTIGRAVITY_OAUTH_CLIENT_ID && refreshCall.form.client_secret === contract.ANTIGRAVITY_OAUTH_CLIENT_SECRET)
  check('the project id, tier and e-mail survive the refresh', accounts.geminiPlanFacts()?.projectId === 'project-fixture-123' && accounts.geminiPlanFacts()?.tier?.paid?.name === 'Google AI Pro' && accounts.geminiPlanFacts()?.email === 'plan@example.invalid')
  const concurrent = JSON.parse(readFileSync(accounts.geminiAuthPathForDisplay(), 'utf8')) as typeof before
  concurrent.plan.tokens.accessTokenExpiresAtMs = Date.now() - 1000
  writeFileSync(accounts.geminiAuthPathForDisplay(), JSON.stringify(concurrent), { mode: 0o600 })
  const refreshesBefore = requests.filter(r => r.host === 'google' && r.form?.grant_type === 'refresh_token').length
  const [a, b] = await Promise.all([accounts.currentGeminiPlanTokens(), accounts.currentGeminiPlanTokens()])
  check('two concurrent refreshes are one request (single-flight)', a?.accessToken === b?.accessToken && requests.filter(r => r.host === 'google' && r.form?.grant_type === 'refresh_token').length === refreshesBefore + 1)
  google.refreshStatus = 400
  google.refreshError = 'invalid_grant'
  const dead = JSON.parse(readFileSync(accounts.geminiAuthPathForDisplay(), 'utf8')) as typeof before
  dead.plan.tokens.accessTokenExpiresAtMs = Date.now() - 1000
  writeFileSync(accounts.geminiAuthPathForDisplay(), JSON.stringify(dead), { mode: 0o600 })
  const dropped = await accounts.currentGeminiPlanTokens()
  check('a revoked refresh token (invalid_grant) drops the sign-in: no silent fall-through, the surfaces read signed out', dropped === undefined && accounts.geminiPlanConnected() === false && accounts.resolveGeminiAccount() === undefined, JSON.stringify(accounts.resolveGeminiAccount()))
  check('the catalogue then names the sign-in door', catalogue.getGeminiAvailability().state === 'disabled' && (catalogue.getGeminiAvailability() as { reason: string }).reason.includes('/logins'))
  google.refreshStatus = 200
  google.refreshError = undefined

  console.log('── a free account: no current tier → onboardUser, the operation polled, the project read ──')
  assist.tierShape = 'onboard'
  assist.onboarded = false
  writeFileSync(accounts.geminiAuthPathForDisplay(), JSON.stringify({ version: 1 }), { mode: 0o600 })
  const onboardStart = requests.length
  const free = await signIn()
  const onboardCalls = requests.slice(onboardStart).filter(r => r.host === 'assist')
  check('the free account is onboarded: onboardUser with tierId free-tier, the operation polled until done, loadCodeAssist again', free.flow === 'resolved' && onboardCalls.some(r => r.path === '/v1internal:onboardUser' && r.body?.tierId === 'free-tier') && onboardCalls.filter(r => r.path === '/v1internal/operations/onboard-fixture').length === 2 && accounts.geminiPlanFacts()?.projectId === 'project-fixture-123', JSON.stringify({ free, calls: onboardCalls.map(r => r.path) }))
  check('the tier reads free and the label says so', access.geminiPlanTierWords(accounts.geminiPlanFacts()?.tier) === 'free' && accounts.resolveGeminiAccount()?.label === 'Google sign-in (free)')

  console.log('── a Code Assist licence names itself ──')
  assist.tierShape = 'licence'
  writeFileSync(accounts.geminiAuthPathForDisplay(), JSON.stringify({ version: 1 }), { mode: 0o600 })
  const licence = await signIn()
  check('a standard-tier account reads as a Code Assist licence', licence.flow === 'resolved' && access.geminiPlanTierWords(accounts.geminiPlanFacts()?.tier) === 'a Code Assist licence')

  console.log('── the refusals, each in Google\'s words ──')
  assist.tierShape = 'ineligible'
  writeFileSync(accounts.geminiAuthPathForDisplay(), JSON.stringify({ version: 1 }), { mode: 0o600 })
  const ineligible = await signIn()
  check('an ineligible account is refused with Google\'s reason verbatim and the validation URL, nothing stored', ineligible.flow === 'rejected' && (ineligible.error ?? '').includes('Your account needs validation before the free tier can be used.') && (ineligible.error ?? '').includes('https://example.invalid/validate') && accounts.geminiPlanConnected() === false, JSON.stringify(ineligible))
  check('the failure receipt keeps Google\'s words and names /logins', login.geminiConnectFailedReceipt(new Error(ineligible.error ?? '')).includes('needs validation') && login.geminiConnectFailedReceipt(new Error(ineligible.error ?? '')).includes('/logins'))
  assist.tierShape = 'paid'
  google.withRefreshToken = false
  const noRefresh = await signIn()
  check('a grant without a refresh token is refused and the user asked to sign in again', noRefresh.flow === 'rejected' && (noRefresh.error ?? '').includes('no refresh token') && accounts.geminiPlanConnected() === false, JSON.stringify(noRefresh))
  google.withRefreshToken = true
  assist.loadStatus = 403
  const forbidden = await signIn()
  check('a 403 from loadCodeAssist is said with the status and Google\'s body, nothing stored', forbidden.flow === 'rejected' && (forbidden.error ?? '').includes('HTTP 403') && (forbidden.error ?? '').includes('loadCodeAssist') && accounts.geminiPlanConnected() === false, JSON.stringify(forbidden))
  assist.loadStatus = 200
  const ok = await signIn()
  check('a good sign-in after the refusals lands', ok.flow === 'resolved' && accounts.geminiPlanConnected())
  assist.rosterStatus = 403
  const refusedRoster = await catalogue.refreshGeminiCatalogue('plan', { force: true })
  check('a refused roster is a refused credential in the catalogue, the sign-in door named', refusedRoster?.lastError?.includes('HTTP 403') === true && catalogue.getGeminiAvailability().state === 'disabled' && (catalogue.getGeminiAvailability() as { why: string; reason: string }).why === 'auth-invalid' && (catalogue.getGeminiAvailability() as { reason: string }).reason.includes('/logins signs in with Google again'), JSON.stringify(catalogue.getGeminiAvailability()))
  assist.rosterStatus = 200
  await catalogue.refreshGeminiCatalogue('plan', { force: true })
  check('the roster read again is ready', catalogue.getGeminiAvailability().state === 'ready')
  const plainEvents = async (model: string, bases: string[]): Promise<Array<Record<string, unknown>>> => {
    const out: Array<Record<string, unknown>> = []
    const current = await accounts.resolveGeminiRequestAuth({ sourceKind: 'plan' })
    for await (const event of streamGeminiContent({ apiKey: current!.headers.authorization!.slice(7), url: `${bases[0]}/v1internal:streamGenerateContent?alt=sse`, request: { model, messages: [{ role: 'user', content: 'hi' }] } as never, messages: [], plan: { ...callModel.nextGeminiPlanEnvelope('project-fixture-123'), bases, userAgent: current!.headers['user-agent']! }, onTurn: () => {} })) out.push(event as Record<string, unknown>)
    return out
  }
  const missing = await plainEvents('gemini-nope', [assistBase])
  const missingFault = missing.find(e => e.type === 'stream-fault') as { fault: { status?: number; message: string } } | undefined
  check('a model not on the roster is a 404 in Google\'s words, never a silent empty reply', missingFault?.fault.status === 404 && missingFault.fault.message.includes('Model gemini-nope not found'), JSON.stringify(missingFault))
  check('the chat words for that refusal name the roster and the sign-in', callModel.geminiPlanModelMissingWords('gemini-nope', 404, 'http-404: Model gemini-nope not found.').includes("Google serves no model 'gemini-nope' to this Google sign-in (HTTP 404)") && callModel.geminiPlanModelMissingWords('gemini-nope', 404, undefined).includes('/model lists the roster'))
  assist.generateStatus = 429
  const exhausted = await plainEvents('gemini-4-argon', [assistBase])
  const exhaustedFault = exhausted.find(e => e.type === 'stream-fault') as { fault: { status?: number; message: string; retryable: boolean } } | undefined
  check('an exhausted quota is Google\'s own words with the retry ask, retryable', exhaustedFault?.fault.status === 429 && exhaustedFault.fault.message.includes('Resource has been exhausted') && exhaustedFault.fault.retryable === true, JSON.stringify(exhaustedFault))
  assist.generateStatus = 200
  assist.generateError = { code: 429, message: 'Quota exceeded for this plan. Please retry after 2026-10-15T00:00:00Z.', status: 'RESOURCE_EXHAUSTED' }
  const inBand = await plainEvents('gemini-4-argon', [assistBase])
  const inBandFault = inBand.find(e => e.type === 'stream-fault') as { fault: { message: string } } | undefined
  check('an in-band quota error on the stream is Google\'s words too', inBandFault?.fault.message.includes('Quota exceeded for this plan') === true, JSON.stringify(inBandFault))
  assist.generateError = undefined

  console.log('── the failover: the daily endpoint down → the sandbox serves, the good base remembered; never a loop ──')
  callModel.__resetGeminiPlanWireForTest()
  const deadBase = 'http://127.0.0.1:1'
  const sandboxBase = `http://127.0.0.1:${sandboxServer.port}`
  const served: string[] = []
  const current = await accounts.resolveGeminiRequestAuth({ sourceKind: 'plan' })
  const failover: Array<Record<string, unknown>> = []
  for await (const event of streamGeminiContent({ apiKey: current!.headers.authorization!.slice(7), url: `${deadBase}/v1internal:streamGenerateContent?alt=sse`, request: { model: 'gemini-4-argon', messages: [{ role: 'user', content: 'hi' }] } as never, messages: [], plan: { ...callModel.nextGeminiPlanEnvelope('project-fixture-123'), bases: [deadBase, assistBase], userAgent: current!.headers['user-agent']!, onServedBy: base => served.push(base) }, onTurn: () => {} })) failover.push(event as Record<string, unknown>)
  check('a dead first base fails over to the second within the request; the answer lands; the serving base is reported', failover.some(e => e.type === 'finish') && served.length === 1 && served[0] === assistBase, JSON.stringify({ served, types: failover.map(e => e.type) }))
  const remembered = callModel.orderedGeminiPlanBases('project-fixture-123', [deadBase, assistBase])
  check('the next request starts from the remembered good base', remembered[0] === deadBase || remembered[0] === assistBase)
  const bothDown: Array<Record<string, unknown>> = []
  for await (const event of streamGeminiContent({ apiKey: current!.headers.authorization!.slice(7), url: `${deadBase}/v1internal:streamGenerateContent?alt=sse`, request: { model: 'gemini-4-argon', messages: [{ role: 'user', content: 'hi' }] } as never, messages: [], plan: { ...callModel.nextGeminiPlanEnvelope('project-fixture-123'), bases: [deadBase, sandboxBase], userAgent: current!.headers['user-agent']!, onServedBy: base => served.push(base) }, onTurn: () => {} })) bothDown.push(event as Record<string, unknown>)
  const bothFault = bothDown.find(e => e.type === 'stream-fault') as { fault: { status?: number } } | undefined
  check('both bases refusing ends in one fault after one try each, never a loop', bothFault !== undefined && served.length === 1 && bothDown.filter(e => e.type === 'stream-fault').length === 1, JSON.stringify(bothDown))

  console.log('── the client version: the manifest unreachable never blocks a request ──')
  const peek = await contract.peekAntigravityClient({ force: true })
  check('under the proof shape an off-box manifest is skipped and the pinned version presents', peek.kind === 'skipped' && contract.presentedAntigravityClient().source === 'constant' && contract.antigravityUserAgent().includes(contract.ANTIGRAVITY_CLIENT_CONTRACT_VERSION))

  console.log('── the active-source rule with three stores ──')
  const noCatalogue = { refreshCatalogue: async () => null }
  const keyed = await login.storeGeminiApiKeyLogin('AIzaFixtureKeyBesidePlan000000000000003', noCatalogue)
  check('a key pasted while the Google sign-in stands becomes the active source and the receipt names the sign-in as stored', accounts.resolveGeminiAccount()?.kind === 'api-key' && keyed.receipt.includes('the active source') && keyed.receipt.includes('Google sign-in stays stored'), keyed.receipt)
  const back = login.activateGeminiSource('plan')
  check('↵ on the Sign in with Google row makes the plan active again without a new sign-in', accounts.resolveGeminiAccount()?.kind === 'plan' && back.receipt.includes('the Google sign-in is now the active source') && back.receipt.includes('An API key is also stored'), back.receipt)
  const threeRows = guide.geminiConnectRows({ keySource: 'stored', oauthConnected: true, clientSource: 'env', planConnected: true, planTier: 'Google AI Pro', active: 'api-key' })
  check('with three stores the two inactive rows offer the switch', threeRows[0]!.label === 'Sign in with Google — connected (Google AI Pro), not active · ↵ makes it active' && threeRows[2]!.label === 'Google account — connected, not active · ↵ makes it active' && threeRows[1]!.label === 'API key — connected (stored locally) · ↵ pastes a replacement', JSON.stringify(threeRows))
  check('the /usage note names the active source and the two others', login.geminiStoredSourcesNote({ keySource: 'stored', oauthConnected: true, planConnected: true, active: 'plan' }) === 'Active source: the Google sign-in · the Google account and an API key are also stored — ↵ on its /logins gemini row makes it active')
  const planSlot = slots.deriveFamilySlotGroups().flatMap(group => group.slots).find(s => s.id === 'gemini:plan')
  const removal = planSlot ? slots.executeSlotRemoval(planSlot) : undefined
  check('the /accounts removal drops the sign-in and says where full revocation lives', removal?.mutated === true && removal.note.includes('myaccount.google.com') && accounts.geminiPlanConnected() === false && accounts.resolveGeminiAccount()?.kind === 'api-key', JSON.stringify(removal))
} finally {
  googleServer.stop(true)
  assistServer.stop(true)
  sandboxServer.stop(true)
}
console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
