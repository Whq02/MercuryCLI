import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { liveFactsOf, withFixtureRunner } from '../lib/builtProduct.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const watchdog = setTimeout(() => {
  console.error('\nTIMEOUT — prove-mcp-auth-tool exceeded 90s')
  process.exit(1)
}, 90_000)
watchdog.unref?.()

const freePort = (): Promise<number> =>
  new Promise(resolve => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })

let tokenHits = 0
let toolCallHits = 0
const FIXTURE_ACCESS_TOKEN = 'fixture-oauth-access-token'

let base = ''
const oauthMcpServer = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req: Request) {
    const url = new URL(req.url)
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] })
    }
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
      return Response.json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true,
      })
    }
    if (url.pathname === '/register') {
      const body = (await req.json()) as { redirect_uris: string[] }
      return Response.json(
        { client_id: 'fixture-client', redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none' },
        { status: 201 },
      )
    }
    if (url.pathname === '/token') {
      await req.text()
      tokenHits++
      return Response.json({
        access_token: FIXTURE_ACCESS_TOKEN,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'fixture-oauth-refresh-token',
      })
    }
    if (url.pathname === '/mcp') {
      const auth = req.headers.get('authorization')
      if (auth !== `Bearer ${FIXTURE_ACCESS_TOKEN}`) {
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
          },
        })
      }
      if (req.method === 'GET') return new Response('', { status: 405 })
      if (req.method === 'DELETE') return new Response('', { status: 200 })
      const msg = (await req.json()) as { id?: number | string; method?: string; params?: Record<string, unknown> }
      if (msg.id === undefined) return new Response('', { status: 202 })
      if (msg.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: (msg.params?.protocolVersion as string | undefined) ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'oauthsrv', version: '1.0.0' },
          },
        })
      }
      if (msg.method === 'tools/list') {
        return Response.json({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [
              {
                name: 'vault_ping',
                description: 'Fixture OAuth-protected ping tool',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          },
        })
      }
      if (msg.method === 'tools/call' && msg.params?.name === 'vault_ping') {
        toolCallHits++
        return Response.json({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: 'OAUTH_VAULT_PONG' }] },
        })
      }
      if (msg.method === 'prompts/list') {
        return Response.json({ jsonrpc: '2.0', id: msg.id, result: { prompts: [] } })
      }
      if (msg.method === 'ping') {
        return Response.json({ jsonrpc: '2.0', id: msg.id, result: {} })
      }
      return Response.json({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${String(msg.method)}` },
      })
    }
    return new Response('not found', { status: 404 })
  },
})
base = `http://127.0.0.1:${oauthMcpServer.port}`

const callbackPort = await freePort()
const scratch = mkdtempSync(join(tmpdir(), 'mcp-auth-tool-'))
const mcpCfgPath = join(scratch, 'mcp.json')
writeFileSync(
  mcpCfgPath,
  JSON.stringify({
    mcpServers: {
      oauthsrv: {
        type: 'http',
        url: `${base}/mcp`,
        oauth: { callbackPort },
      },
    },
  }),
  'utf8',
)

type ToolResultBlock = { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }

function findToolResult(body: unknown, toolUseId: string): ToolResultBlock | undefined {
  const messages = (body as { messages?: Array<{ role?: string; content?: unknown }> } | null)?.messages
  if (!Array.isArray(messages)) return undefined
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    for (const block of msg.content as ToolResultBlock[]) {
      if (block.type === 'tool_result' && block.tool_use_id === toolUseId) return block
    }
  }
  return undefined
}

function toolResultText(block: ToolResultBlock | undefined): string {
  if (!block) return ''
  if (typeof block.content === 'string') return block.content
  if (Array.isArray(block.content)) {
    return block.content
      .map(entry => (typeof (entry as { text?: unknown }).text === 'string' ? (entry as { text: string }).text : ''))
      .join('\n')
  }
  return ''
}

try {
  await withFixtureRunner(
    [
      { kind: 'tool_use', id: 'toolu_auth', name: 'mcp__oauthsrv__authenticate', input: {} },
      { kind: 'text', text: 'AUTH_URL_SHARED.' },
      { kind: 'tool_use', id: 'toolu_vault_ping', name: 'mcp__oauthsrv__vault_ping', input: {} },
      { kind: 'tool_use', id: 'toolu_auth_after', name: 'mcp__oauthsrv__authenticate', input: {} },
      { kind: 'text', text: 'VAULT_PINGED.' },
    ],
    async (runner, api) => {
      runner.onAsk(() => ({ outcome: 'allow' }))

      await runner.prompt('authenticate oauthsrv')
      await runner.waitFor('first turn outcome', row => row.type === 'outcome', 60_000)

      const sessionRow = runner.rows.find(r => r.type === 'session') as { mcp_servers?: Array<{ name: string; status: string }> } | undefined
      const servers = sessionRow?.mcp_servers ?? []
      check('oauthsrv starts in needs-auth state', servers.some(s => s.name === 'oauthsrv' && s.status === 'needs-auth'), JSON.stringify(servers))

      const afterFirstTurn = api.messageRequests().filter(req => !req.path.includes('count_tokens'))
      const firstOffered = (((afterFirstTurn[0]?.body as { tools?: Array<{ name?: string }> } | undefined)?.tools) ?? []).map(
        tool => tool.name,
      )
      check(
        'mcp__oauthsrv__authenticate is offered before sign-in and real tool is absent',
        firstOffered.includes('mcp__oauthsrv__authenticate') && !firstOffered.includes('mcp__oauthsrv__vault_ping'),
        JSON.stringify(firstOffered.filter(n => n?.includes('oauthsrv'))),
      )

      const authResult = findToolResult(afterFirstTurn[1]?.body, 'toolu_auth')
      const authText = toolResultText(authResult)
      const urlMatch = authText.match(/https?:\/\/[^\s]+/)
      const authUrl = urlMatch?.[0] ?? ''
      let parsedAuthUrl: URL | null = null
      try {
        parsedAuthUrl = authUrl ? new URL(authUrl) : null
      } catch {
        parsedAuthUrl = null
      }
      check(
        'authenticate tool returns the OAuth authorization URL without error',
        authResult?.is_error !== true &&
          parsedAuthUrl !== null &&
          parsedAuthUrl.origin === base &&
          parsedAuthUrl.pathname === '/authorize' &&
          Boolean(parsedAuthUrl.searchParams.get('state')) &&
          Boolean(parsedAuthUrl.searchParams.get('redirect_uri')),
        authText.slice(0, 300),
      )

      if (parsedAuthUrl !== null) {
        const redirectUri = parsedAuthUrl.searchParams.get('redirect_uri') ?? ''
        const state = parsedAuthUrl.searchParams.get('state') ?? ''
        const cbResp = await fetch(
          `${redirectUri}?${new URLSearchParams({ code: 'FIXTURE_AUTH_CODE', state, iss: base })}`,
        )
        const cbBody = await cbResp.text()
        check(
          'completing the OAuth callback succeeds and redeems a token',
          cbResp.status === 200 && cbBody.includes('Authentication successful') && tokenHits === 1,
          `status=${cbResp.status} tokenHits=${tokenHits}`,
        )

        const deadline = Date.now() + 15_000
        let connected = false
        while (Date.now() < deadline) {
          const facts = await liveFactsOf(runner)
          const row = facts.mcp.find(s => s.name === 'oauthsrv')
          if (row?.type === 'connected' && (row.toolCount ?? 0) >= 1) {
            connected = true
            break
          }
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        check('oauthsrv reconnects automatically after sign-in with its real tool', connected)

        const outcomesBeforeSecond = runner.rows.filter(r => r.type === 'outcome').length
        await runner.prompt('call vault_ping now')
        await runner.waitFor(
          'second turn outcome',
          () => runner.rows.filter(r => r.type === 'outcome').length > outcomesBeforeSecond,
          60_000,
        )

        const allRequests = api.messageRequests().filter(req => !req.path.includes('count_tokens'))
        const thirdBody = allRequests[2]?.body as { tools?: Array<{ name?: string }>; messages?: unknown } | undefined
        const thirdOffered = (thirdBody?.tools ?? []).map(tool => tool.name)
        const thirdMessagesText = JSON.stringify(thirdBody?.messages ?? [])
        check(
          'after sign-in the server real tool is advertised to the model (in tools or deferred-tools delta)',
          thirdOffered.includes('mcp__oauthsrv__vault_ping') || thirdMessagesText.includes('mcp__oauthsrv__vault_ping'),
          JSON.stringify({ thirdOffered: thirdOffered.filter(n => n?.includes('oauthsrv')), inMessages: thirdMessagesText.includes('mcp__oauthsrv__vault_ping') }),
        )

        const pingResult = findToolResult(allRequests[3]?.body, 'toolu_vault_ping')
        const pingText = toolResultText(pingResult)
        check(
          'calling the newly unlocked tool reaches the authenticated server and returns its output',
          pingResult?.is_error !== true && pingText.includes('OAUTH_VAULT_PONG') && toolCallHits === 1,
          JSON.stringify({ is_error: pingResult?.is_error, text: pingText, toolCallHits }),
        )

        const authAfterResult = findToolResult(allRequests[4]?.body, 'toolu_auth_after')
        const authAfterText = toolResultText(authAfterResult)
        check(
          'calling the authenticate tool after sign-in is rejected because it was removed from live tools',
          authAfterResult?.is_error === true && authAfterText.includes('No such tool available: mcp__oauthsrv__authenticate'),
          JSON.stringify({ is_error: authAfterResult?.is_error, text: authAfterText }),
        )
      }
    },
    { argv: ['--only-mcp', '--mcp', mcpCfgPath] },
  )
} finally {
  oauthMcpServer.stop(true)
  rmSync(scratch, { recursive: true, force: true })
  clearTimeout(watchdog)
}

if (failures > 0) {
  console.error(`\nprove-mcp-auth-tool: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-mcp-auth-tool: all green')
process.exit(0)
