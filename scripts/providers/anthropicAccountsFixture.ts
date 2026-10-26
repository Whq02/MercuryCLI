import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderTurn } from '../lib/fixtureApi.ts'

export const KEY = 'sk-ant-usr-fixture-key'
export const MODEL = 'claude-haiku-5-5'
export const WORKSPACE = 'wrkspc_fixture'
export const WORKSPACE_ERROR = 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header'
export const SUBSCRIPTION = { accessToken: 'fixture-subscriber', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3_600_000, scopes: ['user:profile', 'user:inference'], subscriptionType: 'max' as const, rateLimitTier: 'default_claude_max_5x' as const }

export async function accountsWorld() {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const scratch = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
  mkdirSync(scratch, { recursive: true })
  const home = mkdtempSync(join(scratch, 'anthropic-accounts-'))
  for (const name of Object.keys(process.env)) if (/^(ANTHROPIC_|MERCURY_)/.test(name)) delete process.env[name]
  delete process.env.CI
  delete process.env.NODE_ENV
  process.env.MERCURY_CONFIG_DIR = home
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  const requests: { path: string; key: string | undefined; bearer: string | undefined; workspace: string | undefined; beta: string; body: Record<string, any> }[] = []
  const held: { response: ServerResponse; body: Record<string, any> }[] = []
  let mint: { status: number; body: unknown } = { status: 200, body: { raw_key: KEY, workspace_id: WORKSPACE } }
  let requireWorkspace = false
  let hold = false
  let messageHandler: ((body: Record<string, any>, response: ServerResponse) => boolean) | undefined
  const answer = (res: ServerResponse, body: Record<string, any>) => {
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(renderTurn({ kind: 'text', text: 'fixture answered', model: MODEL }, requests.length))
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'fixture-message', type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: 'fixture answered' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 8, output_tokens: 2 } }))
    }
  }
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    const path = new URL(req.url!, 'http://fixture.invalid').pathname
    const header = (name: string) => req.headers[name] as string | undefined
    requests.push({ path, key: header('x-api-key'), bearer: header('authorization'), workspace: header('anthropic-workspace-id'), beta: header('anthropic-beta') ?? '', body })
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    const refuse = (status: number, message: string) => json(status, { type: 'error', error: { type: status === 401 ? 'authentication_error' : 'invalid_request_error', message } })
    if (path === '/v1/oauth/token') return json(200, { access_token: 'fixture-console', scope: 'org:create_api_key user:profile', expires_in: 3600 })
    if (path === '/api/oauth/profile') return json(200, { account: { uuid: 'fixture-account', email: 'fixture@example.invalid' }, organization: { uuid: 'fixture-org', organization_type: 'api' } })
    if (path === '/api/oauth/claude_cli/create_api_key') return json(mint.status, mint.body)
    if (path === '/api/oauth/claude_cli/roles') return json(200, {})
    if (path === '/api/oauth/usage') return json(200, {})
    const subscriber = header('authorization') === `Bearer ${SUBSCRIPTION.accessToken}`
    if (!subscriber && header('x-api-key') !== KEY) return refuse(401, 'invalid x-api-key')
    if (!subscriber && requireWorkspace && header('anthropic-workspace-id') !== WORKSPACE) return refuse(400, WORKSPACE_ERROR)
    if (path === '/v1/models') return json(200, { data: [{ id: MODEL, type: 'model', display_name: 'Fixture Haiku' }], has_more: false })
    if (path === '/v1/messages/count_tokens') return json(200, { input_tokens: 8 })
    if (path === '/v1/messages') {
      if (subscriber !== (header('anthropic-beta') ?? '').includes('oauth-2025-04-20')) return refuse(401, 'credential and OAuth header disagree')
      if (messageHandler?.(body, res)) return
      if (hold) { held.push({ response: res, body }); return }
      return answer(res, body)
    }
    return json(404, {})
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.ANTHROPIC_BASE_URL = base
  process.env.MERCURY_ANTHROPIC_OAUTH_BASE = base
  const fetch = globalThis.fetch
  globalThis.fetch = ((input, init) => {
    assert.equal(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).origin, base, 'fixture must not reach another origin')
    return fetch(input, init)
  }) as typeof fetch
  const config = await import('../../src/utils/config/globalConfig.ts')
  config.enableConfigs()
  config.getGlobalConfig()
  const auth = await import('../../src/utils/auth.ts')
  return {
    home, base, requests, config, auth,
    onMessage: (handler: typeof messageHandler) => { messageHandler = handler },
    mint: (status: number, body: unknown) => { mint = { status, body } },
    requireWorkspace: () => { requireWorkspace = true },
    hold: () => { hold = true },
    held: () => held.length,
    release: () => { hold = false; for (const row of held.splice(0)) answer(row.response, row.body) },
    close: async () => { globalThis.fetch = fetch; server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); rmSync(home, { recursive: true, force: true }) },
  }
}

export async function fixtureTurn(label = 'fixture turn', agentId?: string) {
  const { routedCallModelSettled } = await import('../../src/services/providers/callModelRouter.ts')
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { asAgentId } = await import('../../src/types/ids.ts')
  return routedCallModelSettled({
    messages: [createUserMessage({ content: label })], systemPrompt: asSystemPrompt(['Answer briefly.']),
    thinkingConfig: { type: 'disabled' }, tools: [], signal: new AbortController().signal,
    options: { model: MODEL, querySource: agentId ? 'agent:custom' : 'sdk', isNonInteractiveSession: true,
      getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], mcpTools: [],
      hasAppendSystemPrompt: false, maxOutputTokensOverride: 32, enablePromptCaching: false,
      ...(agentId ? { agentId: asAgentId(agentId) } : {}),
    },
  })
}

export async function until(read: () => boolean, label = 'fixture condition'): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!read()) {
    assert.ok(Date.now() < deadline, `${label} timed out`)
    await new Promise(done => setTimeout(done, 10))
  }
}
