#!/usr/bin/env bun

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(2)
}
const NODE = process.env.NODE_BIN ?? spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim()
const BAD_MODEL = 'claude-banana-9'
const OFFERED = ['claude-opus-4-8', 'claude-sonnet-4-8', 'claude-haiku-4-5']
const EMAIL = 'record@example.com'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

type Hit = { method: string; url: string; authorization: string }
function fixture(mode: 'live' | 'expired' | 'served'): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? ''
    hits.push({ method: req.method ?? '', url, authorization: String(req.headers.authorization ?? '') })
    const body: Buffer[] = []
    req.on('data', chunk => body.push(chunk as Buffer))
    req.on('end', () => {
      if (mode === 'expired' && (url.startsWith('/v1/models') || url.startsWith('/v1/messages'))) {
        res.writeHead(401, { 'content-type': 'application/json', 'request-id': 'req_fixture_401' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'OAuth token has expired' } }))
        return
      }
      if (req.method === 'GET' && url.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: OFFERED.map(id => ({ id, display_name: id, created_at: '2026-01-01T00:00:00Z', type: 'model' })), has_more: false }))
        return
      }
      if (req.method === 'POST' && url.startsWith('/v1/oauth/token')) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'the refresh token is no longer valid' }))
        return
      }
      if (req.method === 'POST' && url.startsWith('/v1/messages')) {
        if (mode === 'served') {
          const model = JSON.parse(Buffer.concat(body).toString()).model
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          const events = [
            { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture model answered' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
            { type: 'message_stop' },
          ]
          res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
          return
        }
        res.writeHead(404, { 'content-type': 'application/json', 'request-id': 'req_fixture_404' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `model: ${BAD_MODEL}` } }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'no such road' } }))
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        hits,
        close: () => new Promise<void>(done => server.close(() => done())),
      })
    })
  })
}

function scratchHome(tag: string, expiresAt: number): { home: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), `bad-model-${tag}-`))
  const config = join(home, '.mercury')
  mkdirSync(config, { recursive: true })
  const cwd = mkdtempSync(join(tmpdir(), `bad-model-cwd-${tag}-`))
  writeFileSync(
    join(config, '.config.json'),
    JSON.stringify({
      theme: 'dark',
      hasCompletedOnboarding: true,
      oauthAccount: { accountUuid: 'uuid-record-fixture', emailAddress: EMAIL, organizationUuid: 'org-record-fixture' },
      projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    }),
  )
  writeFileSync(
    join(config, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token', expiresAt, scopes: ['user:inference'], subscriptionType: 'max', rateLimitTier: null } }),
  )
  return { home, cwd }
}

async function runProduct(tag: string, expiresAt: number, api: string, model = BAD_MODEL): Promise<{ stdout: string; stderr: string; status: number | null; home: string; cwd: string }> {
  const { home, cwd } = scratchHome(tag, expiresAt)
  const child = spawn(NODE, [DIST, '--model', model, 'run', '--ephemeral', 'hi'], {
    cwd,
    env: {
      HOME: home,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: join(home, '.mercury'),
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      ANTHROPIC_BASE_URL: api,
      MERCURY_ANTHROPIC_OAUTH_BASE: api,
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_TERMINAL_TITLE: '0',
      BROWSER: '/usr/bin/true',
      DEBUG: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const killer = setTimeout(() => child.kill('SIGKILL'), 120_000)
  const status = await new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
  clearTimeout(killer)
  return { stdout, stderr, status, home, cwd }
}

const lines = (text: string): string[] => text.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim() !== '')

section('§1 an uncached sign-in at an overridden endpoint: the wire answers, one line, exit 1, no address')
{
  const api = await fixture('live')
  const run = await runProduct('live', Date.now() + 3_600_000, api.url)
  await api.close()
  const errLines = lines(run.stderr)
  const line = errLines[0] ?? ''
  check('exit 1', run.status === 1, `status ${run.status} · stdout ${run.stdout.slice(0, 200)} · stderr ${run.stderr.slice(0, 400)}`)
  check('stdout empty, stderr exactly one line', run.stdout.trim() === '' && errLines.length === 1, `stdout ${JSON.stringify(run.stdout.slice(0, 200))} · stderr lines ${errLines.length}: ${errLines.join(' |').slice(0, 600)}`)
  check('the wire refusal names the requested model and the endpoint answer', line.includes(BAD_MODEL) && line.includes('404') && !line.includes('not offered'), line)
  check('the line carries no address, no @', !line.includes('@') && !line.includes(EMAIL), line)
  check('no catalogue probe preceded the wire request', api.hits.every(h => !h.url.startsWith('/v1/models')) && api.hits.some(h => h.method === 'POST' && h.url.startsWith('/v1/messages')), JSON.stringify(api.hits.map(h => `${h.method} ${h.url}`)))
  check('no request carried the address either', api.hits.every(h => !h.url.includes('@')), JSON.stringify(api.hits.map(h => h.url)))
  rmSync(run.home, { recursive: true, force: true })
  rmSync(run.cwd, { recursive: true, force: true })
}

section('§1b a fixture-only model at an overridden endpoint reaches the wire without discovery')
{
  const api = await fixture('served')
  const run = await runProduct('served', Date.now() + 3_600_000, api.url, 'claude-fixture-medic')
  await api.close()
  check('the fixture model answers with exit 0', run.status === 0 && run.stdout.includes('fixture model answered'), `${run.status}: ${run.stdout} ${run.stderr}`)
  check('exactly one inference request and no catalogue request', api.hits.length === 1 && api.hits[0]?.method === 'POST' && api.hits[0]?.url.startsWith('/v1/messages') === true, JSON.stringify(api.hits.map(h => `${h.method} ${h.url}`)))
  rmSync(run.home, { recursive: true, force: true })
  rmSync(run.cwd, { recursive: true, force: true })
}

section(`§2 the same sign-in with its token expired and the refresh refused: one line, exit 1, the line names the door (/logins anthropic), never the address`)
{
  const api = await fixture('expired')
  const run = await runProduct('expired', Date.now() - 3_600_000, api.url)
  await api.close()
  const errLines = lines(run.stderr)
  const line = errLines[0] ?? ''
  check('exit 1', run.status === 1, `status ${run.status} · stderr ${run.stderr.slice(0, 400)}`)
  check('stdout empty, stderr exactly one line', run.stdout.trim() === '' && errLines.length === 1, `stdout ${JSON.stringify(run.stdout.slice(0, 200))} · stderr lines ${errLines.length}: ${errLines.join(' |').slice(0, 600)}`)
  check('the line names the family and the door', line.includes('Anthropic') && line.includes('/logins anthropic'), line)
  check('the line carries no address, no @', !line.includes('@') && !line.includes(EMAIL), line)
  check('the line is not the model-not-offered sentence (the catalogue could not be read on an expired token — the door is the honest cause)', !line.includes('not offered'), line)
  rmSync(run.home, { recursive: true, force: true })
  rmSync(run.cwd, { recursive: true, force: true })
}

section('§3 the error composer with a stored account record: the sign-in wall row never carries the address, whatever the identity setting says')
{
  const home = mkdtempSync(join(tmpdir(), 'bad-model-composer-'))
  process.env.MERCURY_CONFIG_DIR = home
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
  process.env.MERCURY_ANTHROPIC_OAUTH_BASE = 'http://127.0.0.1:1'
  for (const key of ['NODE_ENV', 'CI', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN']) delete process.env[key]
  writeFileSync(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3_600_000, scopes: ['user:inference'], subscriptionType: 'max', rateLimitTier: null } }))
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const config = await import('../../src/utils/config.ts')
  config.saveGlobalConfig((current: Record<string, unknown>) => ({ ...current, oauthAccount: { accountUuid: 'uuid-record-fixture', emailAddress: EMAIL, organizationUuid: 'org-record-fixture' } }))
  const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
  setIsInteractive(true)
  const { APIError } = await import('../../src/services/api/sdkErrors.ts')
  const errors = await import('../../src/services/api/errors.ts')
  const rowFor = (status: number, message: string): string => {
    const error = new APIError(status, { type: 'error', error: { type: 'authentication_error', message } }, message, new Headers())
    return JSON.stringify(errors.getAssistantMessageFromError(error, 'claude-opus-4-8').message.content)
  }
  const revoked = rowFor(401, 'OAuth access token has been revoked')
  const expired = rowFor(401, 'OAuth token has expired')
  check('the revoked-sign-in row names the family and the door and carries no address', revoked.includes('Anthropic sign-in expired') && revoked.includes('/logins anthropic') && !revoked.includes('@'), revoked.slice(0, 300))
  check('the expired-sign-in row carries no address', expired.includes('Anthropic sign-in expired') && !expired.includes('@'), expired.slice(0, 300))
  const { anthropicCatalogueRefusal } = await import('../../src/services/providers/catalogueAdmission.ts')
  const catalogue = await import('../../src/services/providers/anthropic/anthropicCatalogue.ts')
  const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.MERCURY_ANTHROPIC_OAUTH_BASE
  catalogue.__resetAnthropicCatalogueForTest()
  const originalFetch = globalThis.fetch
  let requests = 0
  const fetchCatalogue = (async () => {
    requests++
    return new Response(JSON.stringify({ data: OFFERED.map(id => ({ id })), has_more: false }), { status: 200 })
  }) as typeof fetch
  globalThis.fetch = fetchCatalogue
  try {
    check('an uncached first-party door admits without discovery', await anthropicCatalogueRefusal(BAD_MODEL) === null && requests === 0, `${requests} request(s)`)
    await catalogue.refreshAnthropicCatalogue({ door: 'subscription', fetchImpl: fetchCatalogue })
    requests = 0
    const rows: unknown[] = []
    for await (const row of routedCallModel({
      messages: [createUserMessage({ content: 'hi' })], systemPrompt: asSystemPrompt(['fixture']),
      thinkingConfig: { type: 'disabled' }, tools: [], signal: AbortSignal.timeout(5_000),
      options: { model: BAD_MODEL, querySource: 'sdk', agents: [], isNonInteractiveSession: true, mcpTools: [] } as never,
    })) rows.push(row)
    const refusal = JSON.stringify(rows)
    check('a cached active catalogue refuses one unknown-model turn without a request or an address', rows.length === 1 && refusal.includes('not offered') && refusal.includes('Claude subscription live catalogue') && OFFERED.every(id => refusal.includes(id)) && !refusal.includes('@') && requests === 0, refusal)
    check('a listed model remains admitted without discovery', await anthropicCatalogueRefusal(OFFERED[0]!) === null && requests === 0)
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
    await catalogue.refreshAnthropicCatalogue({ door: 'subscription', fetchImpl: fetchCatalogue })
    requests = 0
    check('an override bypasses even a populated catalogue', await anthropicCatalogueRefusal(BAD_MODEL) === null && requests === 0)
    delete process.env.ANTHROPIC_BASE_URL
    writeFileSync(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-other-account', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3_600_000, scopes: ['user:inference'], subscriptionType: 'max', rateLimitTier: null } }))
    const { clearOAuthTokenCache } = await import('../../src/utils/auth.ts')
    clearOAuthTokenCache()
    check('another credential cannot borrow the previous catalogue', await anthropicCatalogueRefusal(BAD_MODEL) === null && requests === 0)
  } finally {
    globalThis.fetch = originalFetch
    catalogue.__resetAnthropicCatalogueForTest()
    rmSync(home, { recursive: true, force: true })
  }
}

section("§4 every provider's error composer, read: no composed error line interpolates an address, an account id, an organisation id or a key")
{
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/CallModel\.ts$|errors\.ts$|credentialWall\.ts$|Refusal\.ts$|Login\.ts$/.test(entry)) files.push(full)
    }
  }
  walk(join(ROOT, 'src', 'services', 'providers'))
  files.push(join(ROOT, 'src', 'services', 'api', 'errors.ts'))
  const identity = /emailAddress|\.email\b|accountId\b|accountUuid|organizationUuid|organizationId|orgId|getOauthAccountInfo|apiKey\.slice|accessToken\.slice|refreshToken/
  const offenders: string[] = []
  let composed = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const source = text.split('\n')
    source.forEach((line, index) => {
      const composes = /API_ERROR_MESSAGE_PREFIX|content: `|createAssistantAPIErrorMessage\(\{ content:/.test(line) && !/^\s*\/\//.test(line)
      if (!composes) return
      composed++
      if (identity.test(line)) offenders.push(`${file.replace(`${ROOT}/`, '')}:${index + 1}: ${line.trim().slice(0, 160)}`)
    })
  }
  check(`${composed} composed error lines across ${files.length} composer files carry no identity field`, composed > 50 && offenders.length === 0, offenders.join('\n'))
  const errorsText = readFileSync(join(ROOT, 'src', 'services', 'api', 'errors.ts'), 'utf8')
  check('the account suffix is gone from the error composer (no " · account " join, no sign-in-wall account reader)', !errorsText.includes('· account ${') && !errorsText.includes('signInWallAccount'), '')
}

console.log(`\n${failures === 0 ? `BAD MODEL LINE GREEN (${checks} checks)` : `BAD MODEL LINE RED — ${failures} failure(s) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
