#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import { Client, StreamableHTTPClientTransport } from '../../src/integrations/mcp-shapes/sdk.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { waitForRow } from '../switchboard/lib/waitForRow.ts'
import { startCrossfamilyFixture } from '../lib/crossfamilyConcourseFixture.ts'
import { runArtifactArena, grabScreens } from '../streaming/artifactArena.ts'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'
import { daemonControlRpc } from '../../src/daemon/control/controlSocket.ts'
import { readSessionWorkers } from '../../src/daemon/concourse-workers/concourseWorkers.ts'
import { readSessionAsks, readSessionFacts } from '../../src/engine/connector/seatProjections.ts'
import { getProjectDir } from '../../src/sessions/transcripts/paths.ts'

const ROOT = resolve(import.meta.dir, '../..')
const HOME = process.env.MERCURY_CONFIG_DIR
if (!HOME || resolve(HOME) === join(process.env.HOME ?? '', '.mercury')) throw new Error('a scratch MERCURY_CONFIG_DIR is required')
const SCRATCH = dirname(HOME)
process.env.TMPDIR = SCRATCH
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_HOME
const DIST = process.env.MERCURY_PROOF_DIST ?? join(ROOT, 'dist/mercury.mjs')
const CAPTURES = process.env.MCP_POPUP_CAPTURE_DIR ?? join(SCRATCH, 'frames')
mkdirSync(CAPTURES, { recursive: true })
const popupSee = `read the captures in ${CAPTURES} (frame-*.txt, model-requests.json, daemon.log, evidence.json)`
const daemonDir = `../${basename(realpathSync(mkdtempSync(join(SCRATCH, 'd-'))))}`
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONCOURSE = 'always'
let checks = 0
let failures = 0
function check(label: string, ok: unknown, detail = '', hint = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!ok && hint ? ` — ${hint}` : ''}`)
}
async function until(pred: () => boolean | Promise<boolean>, ms = S(25_000)): Promise<boolean> {
  const observed = await waitForRow(async () => {
    try { return await pred() ? true : undefined } catch { return undefined }
  }, ms)
  return observed.row === true
}
const rpc = (request: Record<string, unknown>) => daemonControlRpc(request as never, { timeoutMs: 15_000 }) as Promise<Record<string, any>>
const model = await startCrossfamilyFixture({ port: 0, gptId: 'gpt-6-astra' })
const calls: string[] = []
const modelRequests: Array<{ tools: string[]; body: Record<string, unknown> }> = []
let tokenIssued = false
let unauthorized = 0
let callbacks = 0
let initializations = 0
let projectHits = 0
const transports = new Set<WebStandardStreamableHTTPServerTransport>()
const servers = new Set<McpServer>()
const sse = (events: unknown[]): Response => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
const fixture = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const base = url.origin
    if (process.env.DEBUG) console.log('[fixture] ' + req.method + ' ' + url.pathname)
    if (req.headers.get('host') !== url.host || (req.headers.has('origin') && req.headers.get('origin') !== base)) return new Response('untrusted host or origin', { status: 403 })
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] })
    if (url.pathname.startsWith('/.well-known/')) return Response.json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] })
    if (url.pathname === '/register') {
      const metadata = await req.json() as Record<string, unknown>
      return Response.json({ ...metadata, client_id: 'popup-fixture-client', token_endpoint_auth_method: 'none' }, { status: 201 })
    }
    if (url.pathname === '/authorize') {
      const redirect = new URL(url.searchParams.get('redirect_uri')!)
      if (!['127.0.0.1', 'localhost'].includes(redirect.hostname)) return new Response('not loopback', { status: 400 })
      redirect.searchParams.set('code', 'popup-fixture-code')
      redirect.searchParams.set('state', url.searchParams.get('state')!)
      callbacks++
      return Response.redirect(redirect.toString(), 302)
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(await req.text())
      if (form.get('code') !== 'popup-fixture-code' || !form.get('code_verifier')) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      tokenIssued = true
      return Response.json({ access_token: 'popup-fixture-access', token_type: 'Bearer', expires_in: 3600 })
    }
    if (url.pathname === '/project-probe') { projectHits++; return new Response('unapproved fixture', { status: 503 }) }
    if (url.pathname === '/mcp') {
      if (!tokenIssued || req.headers.get('authorization') !== 'Bearer popup-fixture-access') {
        unauthorized++
        return new Response('sign in', { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` } })
      }
      if (req.method === 'GET') return new Response(null, { status: 405 })
      const body = req.method === 'POST' ? await req.clone().json() as { method?: string } : {}
      if (body.method === 'initialize') initializations++
      const server = new McpServer({ name: 'popup-fixture', version: '1.0.0' })
      server.registerTool('popup_echo', {
        description: TOOL_WORDS,
        inputSchema: z.object({ value: z.string(), fail: z.boolean().optional() }),
        outputSchema: z.object({ echo: z.string() }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }, async ({ value, fail }) => {
        if (fail) return { isError: true, content: [{ type: 'text', text: 'fixture handler refused this input' }] }
        calls.push(value)
        return { content: [{ type: 'text', text: `popup-echo:${value}` }], structuredContent: { echo: value } }
      })
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      transports.add(transport); servers.add(server)
      await server.connect(transport)
      return transport.handleRequest(req)
    }
    if (url.pathname === '/openai/v1/responses' && req.method === 'POST') {
      const body = await req.json() as Record<string, any>
      const tools = (body.tools ?? []).map((tool: { name?: string }) => tool.name ?? '')
      modelRequests.push({ tools, body })
      writeFileSync(join(CAPTURES, 'model-requests.json'), JSON.stringify(modelRequests, null, 2))
      const raw = JSON.stringify(body)
      if (raw.includes('call popup fixture')) {
        const name = tools.find((name: string) => name.includes('popup_echo'))
        const deferred = raw.includes('mcp__runpod__popup_echo')
        if (!name && deferred && tools.includes('ToolSearch')) return sse([
          { type: 'response.created', response: { id: 'popup-search' } },
          { type: 'response.output_item.done', item: { type: 'function_call', name: 'ToolSearch', call_id: 'popup-search-call', arguments: JSON.stringify({ query: 'select:mcp__runpod__popup_echo' }) } },
          { type: 'response.completed', response: { id: 'popup-search', usage: { input_tokens: 8, output_tokens: 5 } } },
        ])
        const completed = (body.input ?? []).some((item: { type?: string; call_id?: string }) => item.type === 'function_call_output' && item.call_id === 'popup-tool-call')
        if (!completed && name) return sse([
          { type: 'response.created', response: { id: 'popup-response' } },
          { type: 'response.output_item.done', item: { type: 'function_call', name, call_id: 'popup-tool-call', arguments: JSON.stringify({ value: 'from-model' }) } },
          { type: 'response.completed', response: { id: 'popup-response', usage: { input_tokens: 8, output_tokens: 5 } } },
        ])
        const text = name ? 'popup tool finished' : 'popup tool absent from request'
        return sse([
          { type: 'response.created', response: { id: 'popup-response' } },
          { type: 'response.output_text.delta', delta: text },
          { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } },
          { type: 'response.completed', response: { id: 'popup-response', usage: { input_tokens: 8, output_tokens: 5 } } },
        ])
      }
      return fetch(model.base + url.pathname, { method: req.method, headers: req.headers, body: JSON.stringify(body) })
    }
    return fetch(model.base + url.pathname + url.search, { method: req.method, headers: req.headers, ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: await req.arrayBuffer() } : {}) })
  },
})
const fixtureBase = `http://127.0.0.1:${fixture.port}`
const environment = { ...model.env, MERCURY_OPENAI_API_BASE: `${fixtureBase}/openai/v1`, MERCURY_CONCOURSE: 'always', MERCURY_DAEMON_DIR: daemonDir, MERCURY_CACHE_CLOCK: '0', MERCURY_COORDINATION_MCP: '0', MERCURY_PARTY: '0', MERCURY_TERMINAL_TITLE: '0', MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true' }
let daemon: ReturnType<typeof spawn> | undefined
let sessionId = ''
let runnerId = ''
let configHome = ''
let workspace = ''
let journey: Promise<void> = Promise.resolve()
const facts = () => readSessionFacts(sessionId, daemonDir)
const record = () => Object.values(readSessionWorkers()).find(row => row.sessionId === sessionId)
let beforePid = 0
let escaped = false
let added = false
let signed = false
let signingInFrame = ''
let restarted = false
let projectTrustAsked = false
let projectStayedOff = false
let removed = false
const TITLE = 'MCP Popup'
const BUNDLED_MCP = ['ext:filmcraft:app', 'ext:lightcraft:app', 'ext:photocraft:app']
const TOOL_QUESTION = 'Do you want to proceed?'
const TOOL_WORDS = 'Echo a harmless fixture value to verify the live MCP tool contract.'
const driveText = (path: string): string => {
  if (!existsSync(path)) return ''
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { const row = JSON.parse(line); return row.ts ? [Buffer.from(row.b64, 'base64').toString()] : [] } catch { return [] }
  }).join('')
}
const screenNow = (path: string): string => {
  if (!existsSync(path)) return ''
  try { return grabScreens({ paths: { drive: path }, anchorShiftMs: 0 } as never, 120, 40, [-1])[0]?.rows.join('\n') ?? '' } catch { return '' }
}
let run: Awaited<ReturnType<typeof runArtifactArena>> | undefined
try {
  run = await runArtifactArena({
    distPath: DIST, turns: [], keep: true, cols: 120, rows: 40, seconds: 70, anchor: null,
    sends: [
      `after:${TITLE}:2200:\\t`,
      `after:${TITLE}:4000:\\r`,
      `after:${TITLE}:5400:\\r`,
      { awaitText: 'Type a prompt', afterPrevMs: 1000, text: '/mcp\r' },
      { awaitText: ['Mercury · mcp', ...BUNDLED_MCP.map(name => `${name} · connected`)], afterPrevMs: 500, text: '/runpod' },
      { awaitText: ['runpod', 'needs sign-in'], afterPrevMs: 500, text: '\r' },
      { awaitText: ['runpod', 'connected'], afterPrevMs: 700, text: '\x1b', arrivedAbsent: '↑↓ move · ↵ act' },
      { awaitText: 'Type a prompt', afterPrevMs: 500, text: '/mcp\r' },
      { awaitText: ['runpod', 'connected'], afterPrevMs: 500, text: '\x1b[<0;2;2M\x1b[<0;2;2m', arrivedAbsent: '↑↓ move · ↵ act' },
      { awaitText: 'Type a prompt', afterPrevMs: 700, text: 'call popup fixture\r' },
      { awaitText: ['runpod - popup_echo', TOOL_QUESTION], afterPrevMs: 500, text: '\r' },
    ],
    extraEnv: environment,
    seedHome: async (home, cwd) => {
      configHome = home; workspace = cwd
      process.chdir(cwd)
      mkdirSync(daemonDir, { recursive: true })
      process.env.MERCURY_CONFIG_DIR = home
      seedFirstRun(home, [cwd])
      const fd = openSync(join(CAPTURES, 'daemon.log'), 'a')
      daemon = spawn('node', [DIST, 'daemon', 'run', cwd], { cwd, env: { ...process.env, ...environment, MERCURY_CONFIG_DIR: home }, stdio: ['ignore', fd, fd] })
      check('isolated daemon is ready', await until(async () => (await rpc({ op: 'ping' })).ok === true, S(45_000)), '', 'the daemon started with node dist/mercury.mjs daemon run did not answer ping; read ' + CAPTURES + '/daemon.log')
      const admitted = await rpc({ op: 'sessionDispatch', clientMessageId: 'popup-birth', prompt: 'seat-task-gpt: work on the gpt engine', workspaceDir: cwd, title: TITLE, model: 'gpt-6-astra' })
      sessionId = admitted.sessionId ?? ''; runnerId = admitted.runnerId ?? admitted.workerId ?? ''
      check('session starts with only the bundled MCP servers and reaches the model fixture', admitted.ok === true && await until(() => {
        const roster = facts()?.mcp ?? []
        return roster.length === BUNDLED_MCP.length && BUNDLED_MCP.every(name => roster.some(row => row.name === name && row.type === 'connected' && row.toolCount === 3)) && modelRequests.length > 0
      }), JSON.stringify(admitted), 'the new session must list exactly the three bundled ext:* MCP servers as connected with toolCount 3 and send a request to the model fixture; ' + popupSee)
      beforePid = record()?.pid ?? 0
      const drive = join(dirname(home), 'drive.jsonl')
      journey = (async () => {
        const opened = await until(() => driveText(drive).includes('No matching servers'), S(35_000))
        check('the real MCP popup has no runpod match before server addition', opened, '', 'the /mcp popup never painted No matching servers after /runpod was typed; the empty state is in src/commands/mcp/McpPopup.tsx; ' + popupSee)
        const cli = spawn('node', [DIST, 'mcp', 'add', '--transport', 'http', '--scope', 'user', 'runpod', `${fixtureBase}/mcp`], { cwd, env: { ...process.env, ...environment, MERCURY_CONFIG_DIR: home }, stdio: ['ignore', 'pipe', 'pipe'] })
        let output = ''; cli.stdout.on('data', data => { output += data }); cli.stderr.on('data', data => { output += data })
        const exit = await new Promise<number | null>(resolve => cli.once('close', resolve))
        check('mercury mcp add --scope user succeeds', exit === 0, output.trim(), 'the mercury mcp add command exited non-zero; its output is above; the command is in src/commands/mcp/addCommand.ts')
        added = await until(() => facts()?.mcp.some(row => row.name === 'runpod' && row.type === 'needs-auth') === true)
        check('user-scope add joins the running session without restart', added, '', 'the running session never listed runpod as needs-auth after mcp add; the live dial is recorded by src/daemon/session-seat/sessionKitOp.ts; ' + popupSee)
        check('the kit record names the added server', record()?.kit?.mcp.includes('runpod') === true, '', 'the concourse worker record kit.mcp did not gain runpod after mcp add; ' + popupSee)
        const auth = await until(() => !!facts()?.mcp.find(row => row.name === 'runpod')?.authorizationUrl)
        check('Enter starts the existing OAuth flow', auth, '', 'the runpod row never carried an authorizationUrl after Enter was sent in the popup; ' + popupSee)
        const authorizationUrl = facts()?.mcp.find(row => row.name === 'runpod')?.authorizationUrl
        if (authorizationUrl) {
          check('the signing-in screen is painted before the callback', await until(() => {
            const frame = screenNow(drive)
            if (!frame.includes('signing in… (browser)')) return false
            signingInFrame = frame
            writeFileSync(join(CAPTURES, 'signing-in.txt'), frame + '\n')
            return true
          }), '', 'the popup never painted signing in… (browser) for runpod; the row text comes from stateOf in src/commands/mcp/McpPopup.tsx; ' + popupSee)
          const response = await fetch(authorizationUrl)
          check('loopback OAuth callback completes', response.status === 200, '', 'the fixture authorize redirect to the loopback callback did not return 200; ' + popupSee)
        } else check('loopback OAuth callback completes', false, '', 'the runpod row had no authorizationUrl, so the callback was never fetched; see the Enter starts the existing OAuth flow check; ' + popupSee)
        signed = await until(() => facts()?.mcp.some(row => row.name === 'runpod' && row.type === 'connected') === true)
        check('sign-in changes the same row to connected', signed, '', 'the runpod row never became connected after the OAuth callback; ' + popupSee)
        if (signed && await until(() => calls.includes('from-model'))) {
          const projectDir = join(cwd, '.mercury')
          mkdirSync(projectDir, { recursive: true })
          const projectFile = join(projectDir, 'mcp.json')
          writeFileSync(projectFile, JSON.stringify({ mcpServers: { projectProbe: { type: 'http', url: `${fixtureBase}/project-probe` } } }))
          projectTrustAsked = await until(() => readSessionAsks(sessionId, daemonDir)?.asks.some(ask => ask.input.server === 'projectProbe') === true)
          const trustAsk = readSessionAsks(sessionId, daemonDir)?.asks.find(ask => ask.input.server === 'projectProbe')
          projectStayedOff = projectTrustAsked && projectHits === 0 && !facts()?.mcp.some(row => row.name === 'projectProbe')
          if (trustAsk) await rpc({ op: 'sessionControl', action: 'answer-permission', sessionId, by: 'proof', requestId: trustAsk.requestId, allow: false })
          unlinkSync(projectFile)
          const oldPid = record()?.pid ?? beforePid
          if (oldPid > 0) {
            try { process.kill(oldPid, 'SIGTERM') } catch {}
            await until(() => { try { process.kill(oldPid, 0); return false } catch { return true } }, S(10_000))
            await rpc({ op: 'sessionDispatch', clientMessageId: 'popup-restart', targetSessionId: sessionId, workspaceDir: workspace, prompt: 'seat-task-gpt: restarted MCP runner' })
            restarted = await until(() => (record()?.pid ?? oldPid) !== oldPid && facts()?.mcp.some(row => row.name === 'runpod' && row.type === 'connected') === true, S(30_000))
            if (restarted) {
              const remove = spawn('node', [DIST, 'mcp', 'remove', '--scope', 'user', 'runpod'], { cwd, env: { ...process.env, ...environment, MERCURY_CONFIG_DIR: home }, stdio: 'ignore' })
              const removedExit = await new Promise<number | null>(resolve => remove.once('close', resolve))
              removed = removedExit === 0 && await until(() => !facts()?.mcp.some(row => row.name === 'runpod'))
            }
          }
        }
      })()
    },
  })
  await journey
  const frames = grabScreens(run, 120, 40, Array.from({ length: 134 }, (_, index) => S(2000 + index * 500))).map(frame => ({ at: frame.atMs, text: frame.rows.map(row => row.trimEnd()).join('\n') }))
  for (const [index, frame] of frames.entries()) if (index === 0 || frame.text !== frames[index - 1]!.text) writeFileSync(join(CAPTURES, `frame-${String(frame.at).padStart(6, '0')}.txt`), frame.text + '\n')
  const stepScreens = run.sendLog.flatMap(row => row.screen ? [row.screen.map(line => line.trimEnd()).join('\n')] : [])
  const painted = [...frames.map(frame => frame.text), ...stepScreens, signingInFrame].join('\n')
  check('the popup paints Mercury · mcp in a centered frame', frames.some(frame => frame.text.includes('Mercury · mcp') && frame.text.includes('╭')) || stepScreens.some(text => text.includes('Mercury · mcp') && text.includes('╭')), '', 'no captured frame has the popup title with a box corner; the popup is src/commands/mcp/McpPopup.tsx; ' + popupSee)
  check('the added row paints added just now', painted.includes('runpod') && painted.includes('added just now'), '', 'no frame shows a runpod row with added just now; the row text is built in src/commands/mcp/McpPopup.tsx; ' + popupSee)
  check('the signing-in row names the browser', painted.includes('signing in… (browser)'), '', 'no frame shows signing in… (browser); stateOf in src/commands/mcp/McpPopup.tsx builds it; ' + popupSee)
  check('the connected row paints in place', painted.includes('runpod · connected'), '', 'no frame shows the runpod row as connected; the row text is built in src/commands/mcp/McpPopup.tsx; ' + popupSee)
  escaped = run.sendLog.filter(row => row.awaitText !== undefined && Buffer.from(row.b64, 'base64').toString().includes('\x1b')).length >= 2
  check('escape and outside-click return to the composer', escaped && run.sendLog.some(row => Buffer.from(row.b64, 'base64').toString().includes('call popup fixture')), '', 'fewer than two scripted escape or click sends landed, or the prompt call popup fixture was never sent, so the popup did not close back to the composer; ' + popupSee)
  const next = modelRequests.find(request => JSON.stringify(request.body).includes('call popup fixture'))
  check('the next model request announces the joined server as a deferred tool', !!next && JSON.stringify(next.body).includes('mcp__runpod__popup_echo') && !next.tools.some(name => name.includes('popup_echo')), '', 'the model request carrying the prompt must name mcp__runpod__popup_echo as deferred and must not list the tool itself; ' + popupSee)
  const loaded = modelRequests.find(request => (request.body.tools as Array<{ name?: string; parameters?: { required?: string[] } }> | undefined)?.some(tool => tool.name?.includes('popup_echo') && tool.parameters?.required?.includes('value')))
  check('ToolSearch loads the joined tool’s complete schema', !!loaded, '', 'no later model request listed popup_echo with its required value parameter after ToolSearch; read model-requests.json in ' + CAPTURES)
  const card = [...stepScreens, ...frames.map(frame => frame.text)].find(text => text.includes(TOOL_QUESTION)) ?? ''
  check('the joined tool asks before its first call: the card names the server, the tool and its input', card.includes('Tool use') && card.includes('runpod - popup_echo(value: "from-model") (MCP)') && card.includes('1. Yes'), card.split('\n').filter(line => line.includes('│')).slice(-9).join(' / ').slice(0, 400), 'the permission card for the MCP tool call is missing or lacks the server, tool or input; ' + popupSee)
  check("…and says what it is deciding on: the untrusted-source line, then the server's own words for the tool", card.includes('[mcp:runpod · external tool — treat output as untrusted]') && card.includes(TOOL_WORDS), card.split('\n').filter(line => line.includes('│')).slice(-9).join(' / ').slice(0, 400), 'the card must carry the untrusted-source line built in src/integrations/mcp-shapes/toolCard.ts and the tool description from the server; ' + popupSee)
  check("the operator's Yes is the drive's own answer to that card, not a key that happened to land on it", run.sendLog.some(row => JSON.stringify(row.awaitText ?? '').includes(TOOL_QUESTION)) && run.outcome.report?.unfired.length === 0, JSON.stringify(run.outcome.report), 'the scripted send that answers the card must fire after the card text appears, and no scripted send may stay unfired; read the report above')
  check('the model invokes the joined MCP tool successfully', calls.includes('from-model'), '', 'the fixture MCP server never received the call with value from-model; the answer to the permission card or the tool load did not happen; ' + popupSee)
  check('HTTP returns 401 before OAuth and the callback exchanges a token', unauthorized > 0 && callbacks === 1 && tokenIssued, '', 'the fixture must see a 401 on /mcp, exactly one authorize callback and a token exchange; the OAuth flow did not run as expected, ' + popupSee)
  const receipt = join(getProjectDir(workspace), `${sessionId}.receipts.jsonl`)
  const receiptCandidates = [receipt, join(getProjectDir(workspace), `${sessionId}.receipts.json`)]
  const receiptText = receiptCandidates.filter(existsSync).map(path => readFileSync(path, 'utf8')).join('\n')
  check('a kit-dial receipt names runpod', receiptText.includes('kit-dial') && receiptText.includes('runpod'), receipt, 'the session receipts sidecar has no kit-dial row naming runpod; the row is appended by src/daemon/session-seat/sessionKitOp.ts')
  if (signed) {
    const client = new Client({ name: 'popup-contract', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${fixtureBase}/mcp`), { requestInit: { headers: { authorization: 'Bearer popup-fixture-access' } } }))
    const tools = await client.listTools()
    check('SDK initialization and discovery expose the tool schema', initializations > 0 && tools.tools.some(tool => tool.name === 'popup_echo' && tool.inputSchema.required?.includes('value')), '', 'the fixture MCP server at the proof own fixtureBase did not answer initialize and listTools with popup_echo; this is the proof fixture, not Mercury code')
    const result = await client.callTool({ name: 'popup_echo', arguments: { value: 'sdk' } })
    check('SDK real call validates structured content', result.structuredContent?.echo === 'sdk', '', 'the fixture popup_echo tool did not return structuredContent.echo equal to sdk; this is the proof fixture, not Mercury code')
    const malformed = await client.callTool({ name: 'popup_echo', arguments: { value: 3 } }).catch(() => ({ isError: true }))
    check('malformed input is rejected', malformed.isError === true, '', 'the fixture popup_echo tool accepted a numeric value; its input schema is in the proof fixture, not Mercury code')
    const failed = await client.callTool({ name: 'popup_echo', arguments: { value: 'sdk', fail: true } })
    check('handler failure is a tool error, not a broken transport', failed.isError === true && (await client.listTools()).tools.length === 1, '', 'the fixture must answer a handler failure with isError and keep the transport usable; this is the proof fixture, not Mercury code')
    await client.close()
  } else for (const label of ['SDK initialization and discovery expose the tool schema', 'SDK real call validates structured content', 'malformed input is rejected', 'handler failure is a tool error, not a broken transport']) check(label, false, '', 'the sign-in did not reach connected, so the SDK contract checks were skipped; fix the sign-in checks above first')
  check('a restarted runner lists and connects the same server', restarted, '', 'after the runner process was killed and re-dispatched, the new pid never listed runpod as connected; ' + popupSee)
  check('a newly edited project MCP file requests trust', projectTrustAsked, '', 'writing .mercury/mcp.json with projectProbe raised no permission ask naming the server projectProbe; ' + popupSee)
  check('the project server never connects before its trust answer', projectStayedOff && projectHits === 0, '', 'the project server projectProbe was contacted or listed before the trust ask was answered; the fixture counts hits on /project-probe')
  check('removing a user-scope server disconnects and removes its row', removed, '', 'mercury mcp remove --scope user runpod either exited non-zero or the runpod row stayed in the session roster; ' + popupSee)
  writeFileSync(join(CAPTURES, 'evidence.json'), JSON.stringify({ checks, failures, sessionId, runnerId, modelRequests, calls, record: record(), facts: facts(), sends: run.sendLog, driver: run.driverOut }, null, 2))
} finally {
  await rpc({ op: 'shutdown' }).catch(() => {})
  if (daemon && daemon.exitCode === null) daemon.kill('SIGTERM')
  for (const server of servers) await server.close().catch(() => {})
  for (const transport of transports) await transport.close().catch(() => {})
  fixture.stop(true)
  await model.close()
  run?.cleanup()
}
console.log(`${checks - failures}/${checks} checks passed; ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
