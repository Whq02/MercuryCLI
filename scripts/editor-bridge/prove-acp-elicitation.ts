#!/usr/bin/env bun
// gate-watch: src/services/acp/* src/cli/run.ts src/cli/headless/runnerAsks.ts src/runner/wire/* scripts/mcp/_fixture-estate-server.mjs
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

const ROOT = resolve(import.meta.dir, '..', '..')
const distArg = process.argv.indexOf('--dist')
const DIST = distArg !== -1 && process.argv[distArg + 1] ? resolve(process.argv[distArg + 1]!) : join(ROOT, 'dist', 'mercury.mjs')
const FIXTURE = join(ROOT, 'scripts', 'mcp', '_fixture-estate-server.mjs')
const acpArgv = process.argv.includes('--base-stdio') ? ['acp', '--stdio'] : ['acp']

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const bounded = <T,>(work: Promise<T>, ms: number): Promise<T | { stopReason: 'no-answer' }> =>
  Promise.race([work, new Promise<{ stopReason: 'no-answer' }>(resolve => setTimeout(() => resolve({ stopReason: 'no-answer' }), ms))])
const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise(r => setTimeout(r, 25))
  }
  return cond()
}

if (!existsSync(DIST)) {
  console.log(`❌ ${DIST} absent — build first`)
  process.exit(1)
}
const node = process.execPath.includes('bun') ? 'node' : process.execPath
console.log(`elicitation over ACP — ${DIST}`)
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const configHome = mkdtempSync(join(tmpdir(), 'acp-elicit-config-'))
const projDir = mkdtempSync(join(tmpdir(), 'acp-elicit-proj-'))
const daemonDir = mkdtempSync(join(tmpdir(), 'acp-elicit-daemon-'))
process.env.MERCURY_CONFIG_DIR = configHome
const servers: ChildProcess[] = []
process.on('exit', () => {
  for (const s of servers) {
    try {
      s.kill('SIGKILL')
    } catch {
      continue
    }
  }
  for (const dir of [configHome, projDir, daemonDir]) rmSync(dir, { recursive: true, force: true })
})
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(configHome, [projDir])
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const acp = await import('@agentclientprotocol/sdk')

type Harness = {
  agent: InstanceType<typeof acp.ClientContext>
  updates: Array<Record<string, unknown>>
  elicitations: Array<Record<string, unknown>>
  completes: Array<Record<string, unknown>>
  close: () => void
}

function host(server: ChildProcess, answer: (params: Record<string, unknown>) => unknown): Harness {
  const updates: Harness['updates'] = []
  const elicitations: Harness['elicitations'] = []
  const completes: Harness['completes'] = []
  const app = acp
    .client({ name: 'elicitation-proof' })
    .onNotification('session/update', ctx => {
      updates.push(ctx.params.update as unknown as Record<string, unknown>)
    })
    .onRequest('session/request_permission', () => ({ outcome: { outcome: 'selected' as const, optionId: 'allow' } }))
    .onRequest('elicitation/create', ctx => {
      const params = ctx.params as unknown as Record<string, unknown>
      elicitations.push(params)
      return answer(params) as never
    })
    .onNotification('elicitation/complete', ctx => {
      completes.push(ctx.params as unknown as Record<string, unknown>)
    })
  const stream = acp.ndJsonStream(Writable.toWeb(server.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(server.stdout!) as ReadableStream<Uint8Array>)
  const conn = app.connect(stream)
  return { agent: conn.agent, updates, elicitations, completes, close: () => conn.close() }
}

function spawnServer(apiUrl: string): ChildProcess {
  const child = spawn(node, [DIST, ...acpArgv], {
    cwd: projDir,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, MERCURY_CONFIG_DIR: configHome, ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: apiUrl, MERCURY_DAEMON_DIR: daemonDir, MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_MCP_CALL_IDLE_MINUTES: '0.5' },
  })
  servers.push(child)
  return child
}

const mcpServers = [{ name: 'estate', command: node, args: [FIXTURE], env: [] }]

section("§1 an editor that advertises elicitation gets the MCP server's form question as elicitation/create; its answer reaches the server")
{
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'mcp__estate__ask', input: {}, preText: 'asking the server' },
    { kind: 'text', text: 'the server answered' },
  ])
  const server = spawnServer(api.url)
  const h = host(server, () => ({ action: 'accept', content: { colour: 'blue' } }))
  try {
    await h.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, elicitation: { form: {} } } } as never)
    const created = await h.agent.request('session/new', { cwd: projDir, mcpServers } as never)
    const sid = created.sessionId
    const turn = h.agent.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'ask the server' }] })
    check("the server's question reaches the editor as elicitation/create in form mode with the message and the schema", await until(() => h.elicitations.length === 1, 120_000), j(h.elicitations))
    const asked = h.elicitations[0] ?? {}
    check('the question names the session, the mode, the message and the requested schema', asked.sessionId === sid && asked.mode === 'form' && asked.message === 'What is your favourite colour?' && typeof asked.requestedSchema === 'object', j(asked))
    const settled = await bounded(turn, 90_000)
    check('the turn completes', settled.stopReason === 'end_turn', j(settled))
    const result = h.updates.find(u => u.sessionUpdate === 'tool_call_update' && u.status === 'completed' && j(u).includes('answer:'))
    const said = result === undefined ? '' : (((result.content as Array<{ content?: { text?: string } }> | undefined) ?? []).map(c => c.content?.text ?? '').join(''))
    check("the editor's answer reached the server: the tool result carries accept and the colour", said.includes('"action":"accept"') && said.includes('"colour":"blue"'), said)
    await h.agent.request('session/close', { sessionId: sid }).catch(() => {})
  } catch (error) {
    check('the section ran to its end', false, error instanceof Error ? error.message : String(error))
  }
  h.close()
  server.kill('SIGKILL')
  await api.close()
}

section('§2 an editor that declares no elicitation: the question is answered cancel at once, the turn goes on, the editor is never asked')
{
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'mcp__estate__ask', input: {}, preText: 'asking the server' },
    { kind: 'text', text: 'the server answered' },
  ])
  const server = spawnServer(api.url)
  const h = host(server, () => ({ action: 'accept', content: { colour: 'blue' } }))
  try {
    await h.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } })
    const created = await h.agent.request('session/new', { cwd: projDir, mcpServers } as never)
    const sid = created.sessionId
    const t0 = Date.now()
    const settled = await bounded(h.agent.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'ask the server' }] }), 90_000)
    check(`the turn completes without a hang (${Date.now() - t0} ms)`, settled.stopReason === 'end_turn' && Date.now() - t0 < 60_000, j(settled))
    check('the editor was never asked', h.elicitations.length === 0)
    const result = h.updates.find(u => u.sessionUpdate === 'tool_call_update' && u.status === 'completed' && j(u).includes('answer:'))
    const said = result === undefined ? '' : (((result.content as Array<{ content?: { text?: string } }> | undefined) ?? []).map(c => c.content?.text ?? '').join(''))
    check('the server got the cancel answer', said.includes('"action":"cancel"'), said)
    await h.agent.request('session/close', { sessionId: sid }).catch(() => {})
  } catch (error) {
    check('the section ran to its end', false, error instanceof Error ? error.message : String(error))
  }
  h.close()
  server.kill('SIGKILL')
  await api.close()
}

console.log('')
if (failures > 0) {
  console.log(`❌ acp elicitation: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log("✅ acp elicitation: an MCP server's question reaches the editor that can answer it, and never hangs the one that cannot")
