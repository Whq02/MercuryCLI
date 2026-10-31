#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise(r => setTimeout(r, 20))
  }
  return cond()
}
const errorOf = async (work: Promise<unknown>): Promise<{ code?: number; message?: string; data?: unknown } | null> => {
  try {
    await work
    return null
  } catch (error) {
    const e = error as { code?: number; message?: string; data?: unknown }
    return { code: e.code, message: e.message, data: e.data }
  }
}

if (!existsSync(DIST)) {
  console.log(`❌ ${DIST} absent — build first`)
  process.exit(1)
}
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the proof exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

const configHome = mkdtempSync(join(tmpdir(), 'acp-sign-in-config-'))
const projDir = mkdtempSync(join(tmpdir(), 'acp-sign-in-proj-'))
process.env.MERCURY_CONFIG_DIR = configHome
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR']) delete process.env[name]
const children: ChildProcess[] = []
process.on('exit', () => {
  for (const child of children) {
    try {
      child.kill('SIGKILL')
    } catch {
      continue
    }
  }
  for (const dir of [configHome, projDir]) rmSync(dir, { recursive: true, force: true })
})

const { seedFirstRun, FIXTURE_API_KEY } = await import('../lib/firstRunSeed.ts')
seedFirstRun(configHome, [projDir])
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const acp = await import('@agentclientprotocol/sdk')
const { runAcpServer } = await import('../../src/services/acp/acpServer.ts')
const { ACP_DEVICE_FAMILIES, ACP_LOGIN_FLAG } = await import('../../src/services/acp/acpSignIn.ts')
type Roads = NonNullable<Parameters<typeof runAcpServer>[0]>['signIn']

const runner = join(projDir, 'runner.mjs')
writeFileSync(runner, `import { createInterface } from 'node:readline'
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocol: 1, runner: { version: 'proof', pid: process.pid }, session_id: 'fixture' } })
})
`)
const node = process.execPath.includes('bun') ? 'node' : process.execPath

type Harness = {
  agent: InstanceType<typeof acp.ClientContext>
  elicitations: Array<Record<string, unknown>>
  completes: Array<Record<string, unknown>>
  close: () => Promise<void>
}

function host(roads: Roads, answer: (params: Record<string, unknown>) => unknown): Harness {
  const toServer = new PassThrough()
  const fromServer = new PassThrough()
  const served = runAcpServer({ input: toServer, output: fromServer, entry: { node, script: runner }, ...(roads ? { signIn: roads } : {}) })
  const elicitations: Harness['elicitations'] = []
  const completes: Harness['completes'] = []
  const app = acp
    .client({ name: 'sign-in-proof' })
    .onRequest('elicitation/create', ctx => {
      const params = ctx.params as unknown as Record<string, unknown>
      elicitations.push(params)
      return answer(params) as never
    })
    .onNotification('elicitation/complete', ctx => {
      completes.push(ctx.params as unknown as Record<string, unknown>)
    })
  const conn = app.connect(acp.ndJsonStream(Writable.toWeb(toServer) as WritableStream<Uint8Array>, Readable.toWeb(fromServer) as ReadableStream<Uint8Array>))
  return {
    agent: conn.agent,
    elicitations,
    completes,
    close: async () => {
      conn.close()
      toServer.end()
      await Promise.race([served, new Promise(r => setTimeout(r, 2000))])
    },
  }
}

const calls: string[] = []
let deviceAnswer = 'none' as string
const roads: NonNullable<Roads> = {
  claude: async io => {
    calls.push('claude')
    io.showUrl('https://example.invalid/claude-sign-in')
    process.env.ANTHROPIC_API_KEY = FIXTURE_API_KEY
  },
  device: async (family, io) => {
    calls.push(`device:${family}`)
    io.onCode({ verificationUri: 'https://example.invalid/device', userCode: 'ABCD-1234' })
    await until(() => io.cancelled(), 300)
    deviceAnswer = io.cancelled() ? 'cancelled' : 'ok'
    return io.cancelled() ? { ok: false, receipt: `${family} sign-in cancelled — nothing stored.` } : { ok: true, receipt: `${family} signed in` }
  },
}

section('§1 initialize: the methods carry the spec field names, and the terminal method rides the client capability')
let elicitationAnswer: unknown = { action: 'accept' }
const h = host(roads, () => elicitationAnswer)
{
  const init = await h.agent.request('initialize', {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, auth: { terminal: true }, elicitation: { url: {} } },
  } as never)
  const methods = (init.authMethods ?? []) as Array<Record<string, unknown>>
  const terminal = methods.find(m => m.id === 'terminal')
  check('a terminal method is declared when clientCapabilities.auth.terminal is true', terminal !== undefined, j(methods))
  check('the terminal method carries type "terminal", a name and args ["--login"]', terminal?.type === 'terminal' && typeof terminal.name === 'string' && j(terminal.args) === j([ACP_LOGIN_FLAG]), j(terminal))
  const claude = methods.find(m => m.id === 'claude')
  check('the Claude sign-in is an agent method (no type field — the spec default)', claude !== undefined && !('type' in claude) && typeof claude.name === 'string', j(claude))
  const deviceIds = methods.filter(m => (ACP_DEVICE_FAMILIES as readonly string[]).includes(String(m.id))).map(m => m.id)
  check('every device-code family is an agent method when the client renders url elicitations', j(deviceIds) === j([...ACP_DEVICE_FAMILIES]), j(deviceIds))
  check('agentInfo still names mercury', init.agentInfo?.name === 'mercury')
}

section('§2 session/new and session/load before any sign-in answer auth_required (-32000) naming the methods')
{
  const err = await errorOf(h.agent.request('session/new', { cwd: projDir, mcpServers: [] }))
  check('session/new is refused with -32000', err?.code === -32000, j(err))
  check('the refusal names the method ids', (err?.message ?? '').includes('terminal') && (err?.message ?? '').includes('claude') && j((err?.data as { authMethods?: unknown })?.authMethods ?? null).includes('claude'), j(err))
  const load = await errorOf(h.agent.request('session/load', { cwd: projDir, sessionId: 'no-such-session', mcpServers: [] }))
  check('session/load is refused the same way', load?.code === -32000, j(load))
}

section('§3 authenticate: the terminal method is refused with the one line (the editor runs the agent with --login), an unknown id names the methods')
{
  const terminal = await errorOf(h.agent.request('authenticate', { methodId: 'terminal' }))
  check('authenticate(terminal) answers -32602 and names the --login road', terminal?.code === -32602 && (terminal.message ?? '').includes(`mercury acp ${ACP_LOGIN_FLAG}`), j(terminal))
  const unknown = await errorOf(h.agent.request('authenticate', { methodId: 'frobnicate' }))
  check('authenticate(unknown) answers -32602 and lists the methods', unknown?.code === -32602 && (unknown.message ?? '').includes('terminal, claude'), j(unknown))
  check('neither refusal ran a sign-in road', calls.length === 0, j(calls))
}

section('§4 authenticate(claude) runs the browser road, shows the link through a url elicitation, and answers {}')
{
  const result = await h.agent.request('authenticate', { methodId: 'claude' })
  check('authenticate answers an empty result', j(result) === j({}), j(result))
  check('the claude road ran once', j(calls) === j(['claude']), j(calls))
  const shown = h.elicitations[0]
  check('the sign-in link went to the editor as a request-scoped url elicitation', shown?.mode === 'url' && shown.url === 'https://example.invalid/claude-sign-in' && 'requestId' in shown && typeof shown.elicitationId === 'string', j(shown))
  check('elicitation/complete followed', await until(() => h.completes.length === 1 && h.completes[0]?.elicitationId === shown?.elicitationId, 2000), j(h.completes))
}

section('§5 after the sign-in, session/new opens')
{
  const created = await h.agent.request('session/new', { cwd: projDir, mcpServers: [] })
  check('session/new answers a session id once a credential is present', typeof created.sessionId === 'string' && created.sessionId.length >= 8, j(created))
  await h.agent.request('session/close', { sessionId: created.sessionId } as never)
}

section('§6 authenticate(<device family>): the code rides the url elicitation; accept completes, decline cancels the poll')
{
  const okResult = await h.agent.request('authenticate', { methodId: 'moonshot' })
  const shown = h.elicitations[1]
  check('accept: the device road ran and authenticate answered {}', j(okResult) === j({}) && calls[1] === 'device:moonshot' && deviceAnswer === 'ok', `${j(calls)} ${deviceAnswer}`)
  check('the elicitation message carries the code and the url the user visits', shown?.mode === 'url' && String(shown.message).includes('ABCD-1234') && shown.url === 'https://example.invalid/device', j(shown))
  check('elicitation/complete followed the token', await until(() => h.completes.length === 2, 2000), j(h.completes))
  elicitationAnswer = { action: 'decline' }
  const declined = await errorOf(h.agent.request('authenticate', { methodId: 'xai' }))
  check('decline: the poll is cancelled and authenticate answers -32000 with the road\'s receipt', declined?.code === -32000 && (declined.message ?? '').includes('cancelled') && deviceAnswer === 'cancelled', j(declined))
}
await h.close()

section('§7 a client without the terminal capability or url elicitation gets the agent method alone; the registry validator\'s _meta spelling counts as the terminal capability')
{
  const plain = host(roads, () => ({ action: 'cancel' }))
  const init = await plain.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } })
  const ids = (init.authMethods ?? []).map((m: { id: string }) => m.id)
  check('no terminal method and no device-code methods without the capabilities', j(ids) === j(['claude']), j(ids))
  await plain.close()
  const registry = host(roads, () => ({ action: 'cancel' }))
  const viaMeta = await registry.agent.request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'ACP Registry Validator', version: '1.0.0' },
    clientCapabilities: { terminal: true, fs: { readTextFile: true, writeTextFile: true }, _meta: { terminal_output: true, 'terminal-auth': true } },
  } as never)
  const types = (viaMeta.authMethods ?? []).map((m: Record<string, unknown>) => (typeof m.type === 'string' ? m.type : 'agent'))
  check('the registry handshake sees a terminal method and an agent method', types.includes('terminal') && types.includes('agent'), j(viaMeta.authMethods))
  await registry.close()
}

section('§8 the built product: the registry handshake, mercury acp --login without a terminal, and the help line')
{
  const dist = spawn(node, [DIST, 'acp'], { cwd: projDir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MERCURY_CONFIG_DIR: configHome, TERM: 'dumb' } })
  children.push(dist)
  let out = ''
  dist.stdout.on('data', d => {
    out += d.toString()
  })
  dist.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientInfo: { name: 'ACP Registry Validator', version: '1.0.0' }, clientCapabilities: { terminal: true, fs: { readTextFile: true, writeTextFile: true }, _meta: { terminal_output: true, 'terminal-auth': true } } } })}\n`)
  const answered = await until(() => out.includes('\n'), 60_000)
  const reply = answered ? (JSON.parse(out.split('\n')[0]!) as { result?: { authMethods?: Array<Record<string, unknown>> } }) : null
  const types = (reply?.result?.authMethods ?? []).map(m => (typeof m.type === 'string' ? m.type : 'agent'))
  check('dist: initialize carries a terminal and an agent method under the registry validator\'s handshake', types.includes('terminal') && types.includes('agent'), out.slice(0, 400))
  dist.kill('SIGTERM')
  const noTty = spawnSync(node, [DIST, 'acp', ACP_LOGIN_FLAG], { cwd: projDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MERCURY_CONFIG_DIR: configHome } })
  check('dist: mercury acp --login without a terminal exits 2 with one line', noTty.status === 2 && noTty.stderr.trim() === `mercury acp ${ACP_LOGIN_FLAG} needs a terminal.` && noTty.stdout === '', j({ status: noTty.status, err: noTty.stderr.slice(0, 200) }))
  const help = spawnSync(node, [DIST, 'acp', '--help'], { cwd: projDir, encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: configHome } })
  check('dist: mercury acp --help names --login beside the server sentence', help.status === 0 && help.stdout.includes('--login') && help.stdout.includes('Serve an editor over the Agent Client Protocol on stdio.'), help.stdout)
  const stray = spawnSync(node, [DIST, 'acp', ACP_LOGIN_FLAG, 'extra'], { cwd: projDir, encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: configHome } })
  check('dist: a stray argument beside --login is the unknown option named', stray.status === 2 && stray.stderr.startsWith("error: unknown option 'extra'"), j({ status: stray.status, err: stray.stderr.slice(0, 120) }))
}

console.log(`\nACP sign-in: ${failures} failure(s)`)
clearTimeout(guard)
process.exit(failures ? 1 : 0)
