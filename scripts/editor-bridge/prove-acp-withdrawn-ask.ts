#!/usr/bin/env bun
// gate-watch: src/services/acp/* src/cli/print.ts src/cli/headless/runnerAsks.ts src/runner/wire/*
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

const ROOT = resolve(import.meta.dir, '..', '..')
const distArg = process.argv.indexOf('--dist')
const DIST = distArg !== -1 && process.argv[distArg + 1] ? resolve(process.argv[distArg + 1]!) : join(ROOT, 'dist', 'mercury.mjs')

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
console.log(`withdrawn ask over ACP — ${DIST}`)
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const configHome = mkdtempSync(join(tmpdir(), 'acp-withdrawn-config-'))
const projDir = mkdtempSync(join(tmpdir(), 'acp-withdrawn-proj-'))
const daemonDir = mkdtempSync(join(tmpdir(), 'acp-withdrawn-daemon-'))
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
  asks: Array<{ params: Record<string, unknown>; withdrawn: boolean; answeredAt: number | null }>
  close: () => void
}

function host(server: ChildProcess, answer: (ask: Harness['asks'][number], signal: AbortSignal) => Promise<unknown>): Harness {
  const updates: Harness['updates'] = []
  const asks: Harness['asks'] = []
  const app = acp
    .client({ name: 'withdrawn-ask-proof' })
    .onNotification('session/update', ctx => {
      updates.push(ctx.params.update as unknown as Record<string, unknown>)
    })
    .onRequest('session/request_permission', ctx => {
      const ask = { params: ctx.params as unknown as Record<string, unknown>, withdrawn: false, answeredAt: null as number | null }
      asks.push(ask)
      ctx.signal.addEventListener('abort', () => {
        ask.withdrawn = true
      }, { once: true })
      return answer(ask, ctx.signal) as never
    })
  const stream = acp.ndJsonStream(Writable.toWeb(server.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(server.stdout!) as ReadableStream<Uint8Array>)
  const conn = app.connect(stream)
  return { agent: conn.agent, updates, asks, close: () => conn.close() }
}

const acpArgv = process.argv.includes('--base-stdio') ? ['acp', '--stdio'] : ['acp']

function spawnServer(apiUrl: string, env: Record<string, string> = {}): ChildProcess {
  const child = spawn(node, [DIST, ...acpArgv], {
    cwd: projDir,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, MERCURY_CONFIG_DIR: configHome, ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: apiUrl, MERCURY_DAEMON_DIR: daemonDir, MERCURY_LOCAL_PROBE_TARGETS: 'none', ...env },
  })
  servers.push(child)
  return child
}

const answerOnWithdrawal = (ask: Harness['asks'][number], signal: AbortSignal): Promise<unknown> =>
  new Promise(resolveAnswer => {
    const done = (): void => {
      ask.answeredAt = Date.now()
      resolveAnswer({ outcome: { outcome: 'cancelled' } })
    }
    if (signal.aborted) done()
    else signal.addEventListener('abort', done, { once: true })
  })

section("§1 the editor's cancel: the runner withdraws the open ask and the editor's card is cancelled ($/cancel_request), the turn settles cancelled")
{
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'Write', input: { file_path: join(projDir, 'withdrawn.txt'), content: 'never\n' }, preText: 'writing' },
    { kind: 'text', text: 'never said' },
  ])
  const server = spawnServer(api.url)
  const h = host(server, answerOnWithdrawal)
  try {
    await h.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } })
    const created = await h.agent.request('session/new', { cwd: projDir, mcpServers: [] })
    const sid = created.sessionId
    const turn = h.agent.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'write it' }] })
    check('the Write ask reaches the editor as session/request_permission', await until(() => h.asks.length === 1, 90_000), j(h.asks.map(a => a.params)))
    const ask = h.asks[0]!
    check('the ask names the tool call and offers allow and deny', j(ask.params).includes('Write') && Array.isArray(ask.params.options), j(ask.params))
    await h.agent.notify('session/cancel', { sessionId: sid })
    const withdrawn = await until(() => ask.withdrawn, 20_000)
    check("the editor's pending card is withdrawn: the agent sent $/cancel_request for the request", withdrawn)
    const settled = await bounded(turn, 30_000)
    check('the prompt settles cancelled', settled.stopReason === 'cancelled', j(settled))
    check('nothing was written', !existsSync(join(projDir, 'withdrawn.txt')))
    await h.agent.request('session/close', { sessionId: sid }).catch(() => {})
  } catch (error) {
    check('the section ran to its end', false, error instanceof Error ? error.message : String(error))
  }
  h.close()
  server.kill('SIGKILL')
  await api.close()
}

section('§2 a PermissionRequest hook decides first: the editor saw the ask and sees it withdrawn; the turn runs on with the hook\'s answer')
{
  mkdirSync(join(projDir, '.mercury'), { recursive: true })
  writeFileSync(
    join(projDir, '.mercury', 'settings.json'),
    JSON.stringify({
      events: {
        hooks: {
          PermissionRequest: [
            {
              matcher: 'Write',
              hooks: [{ type: 'command', command: `sleep 1; echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'the project hook says no' } } })}'` }],
            },
          ],
        },
      },
    }),
  )
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'Write', input: { file_path: join(projDir, 'hooked.txt'), content: 'never\n' }, preText: 'writing' },
    { kind: 'text', text: 'the hook answered' },
  ])
  const server = spawnServer(api.url)
  const h = host(server, answerOnWithdrawal)
  try {
    await h.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } })
    const created = await h.agent.request('session/new', { cwd: projDir, mcpServers: [] })
    const sid = created.sessionId
    const turn = h.agent.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'write it' }] })
    check('the ask reaches the editor before the hook has decided', await until(() => h.asks.length === 1, 90_000), j(h.asks.map(a => a.params)))
    const ask = h.asks[0]!
    const withdrawn = await until(() => ask.withdrawn, 20_000)
    check('the hook decided first: the editor\'s card is withdrawn without any answer from the editor', withdrawn)
    const settled = await bounded(turn, 30_000)
    check('the turn ran on with the hook\'s denial and ended normally', settled.stopReason === 'end_turn', j(settled))
    const result = h.updates.find(u => u.sessionUpdate === 'tool_call_update' && u.status === 'failed')
    check("the tool call failed with the hook's words", result !== undefined && j(result).includes('the project hook says no'), j(result))
    check('nothing was written', !existsSync(join(projDir, 'hooked.txt')))
    await h.agent.request('session/close', { sessionId: sid }).catch(() => {})
  } catch (error) {
    check('the section ran to its end', false, error instanceof Error ? error.message : String(error))
  }
  h.close()
  server.kill('SIGKILL')
  await api.close()
  rmSync(join(projDir, '.mercury', 'settings.json'), { force: true })
}

console.log('')
if (failures > 0) {
  console.log(`❌ acp withdrawn ask: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ acp withdrawn ask: a withdrawn ask never leaves a stale card in the editor')
