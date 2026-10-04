#!/usr/bin/env bun
// gate-watch: src/services/acp/* src/types/permissions.ts src/utils/permissions/PermissionMode.ts src/cli/run.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

const ROOT = resolve(import.meta.dir, '..', '..')
const distArg = process.argv.indexOf('--dist')
const DIST = distArg !== -1 && process.argv[distArg + 1] ? resolve(process.argv[distArg + 1]!) : join(ROOT, 'dist', 'mercury.mjs')
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
console.log(`the ACP mode list and the Sovereign consent — ${DIST}`)
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const configHome = mkdtempSync(join(tmpdir(), 'acp-modes-config-'))
const projDir = mkdtempSync(join(tmpdir(), 'acp-modes-proj-'))
const daemonDir = mkdtempSync(join(tmpdir(), 'acp-modes-daemon-'))
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
const { PERMISSION_MODES } = await import('../../src/types/permissions.ts')
const acp = await import('@agentclientprotocol/sdk')

type Harness = {
  agent: InstanceType<typeof acp.ClientContext>
  updates: Array<Record<string, unknown>>
  asks: Array<Record<string, unknown>>
  close: () => void
}

function host(server: ChildProcess, answer: (params: Record<string, unknown>) => unknown): Harness {
  const updates: Harness['updates'] = []
  const asks: Harness['asks'] = []
  const app = acp
    .client({ name: 'modes-proof' })
    .onNotification('session/update', ctx => {
      updates.push(ctx.params.update as unknown as Record<string, unknown>)
    })
    .onRequest('session/request_permission', ctx => {
      const params = ctx.params as unknown as Record<string, unknown>
      asks.push(params)
      return answer(params) as never
    })
  const stream = acp.ndJsonStream(Writable.toWeb(server.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(server.stdout!) as ReadableStream<Uint8Array>)
  const conn = app.connect(stream)
  return { agent: conn.agent, updates, asks, close: () => conn.close() }
}

function spawnServer(apiUrl: string): ChildProcess {
  const child = spawn(node, [DIST, ...acpArgv], {
    cwd: projDir,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, MERCURY_CONFIG_DIR: configHome, ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: apiUrl, MERCURY_DAEMON_DIR: daemonDir, MERCURY_LOCAL_PROBE_TARGETS: 'none' },
  })
  servers.push(child)
  return child
}

const errorOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

section('§1 the mode list is the product\'s own, and an unknown word is refused naming it')
const api = await startFixtureApi([{ kind: 'text', text: 'hello' }, { kind: 'text', text: 'hello again' }])
const server = spawnServer(api.url)
let consent: 'allow' | 'deny' = 'deny'
const h = host(server, params => (j(params).includes('Sovereign Mode') ? { outcome: { outcome: 'selected', optionId: consent } } : { outcome: { outcome: 'selected', optionId: 'allow' } }))
try {
  await h.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } })
  const created = await h.agent.request('session/new', { cwd: projDir, mcpServers: [] })
  const sid = created.sessionId
  const offered = (created.modes?.availableModes ?? []).map(m => m.id)
  check('session/new offers the product\'s mode list exactly (the one list, in its order)', j(offered) === j([...PERMISSION_MODES]), j(offered))
  const configured = (created.configOptions ?? []).find(o => o.id === 'permission-mode') as { options?: Array<{ value: string }> } | undefined
  check('the permission-mode config option lists the same words', j((configured?.options ?? []).map(o => o.value)) === j([...PERMISSION_MODES]), j(configured))
  const names = (created.modes?.availableModes ?? []).map(m => m.name)
  check("the names are the product's titles (Sovereign Mode, Don't Ask, Apollo Mode among them)", names.includes('Sovereign Mode') && names.includes("Don't Ask") && names.includes('Apollo Mode'), j(names))
  const unknown = await errorOf(h.agent.request('session/set_mode', { sessionId: sid, modeId: 'frobnicate' }))
  check('an unknown word is refused and the refusal lists the modes', unknown.includes("unknown mode 'frobnicate'") && unknown.includes('sovereign') && unknown.includes('apollo'), unknown)

  for (const modeId of offered.filter(mode => mode !== 'sovereign')) {
    const selected = await errorOf(h.agent.request('session/set_mode', { sessionId: sid, modeId }))
    check(`every offered mode is selectable: ${modeId}`, selected === '', selected)
    const configuredMode = await errorOf(h.agent.request('session/set_config_option', { sessionId: sid, configId: 'permission-mode', value: modeId }))
    check(`every offered mode is configurable: ${modeId}`, configuredMode === '', configuredMode)
  }
  await h.agent.request('session/set_mode', { sessionId: sid, modeId: 'default' })

  section('§2 Sovereign over ACP: the user\'s consent is asked on the editor\'s own card; declined stays out, allowed lands and is never saved')
  consent = 'deny'
  const declined = await errorOf(h.agent.request('session/set_mode', { sessionId: sid, modeId: 'sovereign' }))
  check('the consent card reached the editor as a permission request titled Sovereign Mode', h.asks.some(a => j(a).includes('Sovereign Mode')), j(h.asks))
  check('declined: the mode is refused naming the consent', declined.includes('consent'), declined)
  check('declined: no current_mode_update to sovereign', !h.updates.some(u => u.sessionUpdate === 'current_mode_update' && u.currentModeId === 'sovereign'))
  consent = 'allow'
  const allowed = await errorOf(h.agent.request('session/set_mode', { sessionId: sid, modeId: 'sovereign' }))
  check('allowed: the runner confirms sovereign (the session was launched armed) and the editor hears current_mode_update', allowed === '' && (await until(() => h.updates.some(u => u.sessionUpdate === 'current_mode_update' && u.currentModeId === 'sovereign'), 10_000)), allowed)
  const savedPath = join(configHome, 'projects', `${encodeURIComponent(projDir).replace(/%2F/g, '-')}`)
  void savedPath
  const turn = await h.agent.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'hi' }] })
  check('a turn runs in sovereign', turn.stopReason === 'end_turn', j(turn))
  await h.agent.request('session/close', { sessionId: sid }).catch(() => {})

  section('§3 a saved sovereign is never resumed: the consent is per request')
  const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
  const saved = join(getProjectDir(projDir), `${encodeURIComponent(sid)}.acp.json`)
  const record = existsSync(saved) ? (JSON.parse(readFileSync(saved, 'utf8')) as { permissionMode?: string }) : null
  check('the saved mode record holds default, not sovereign', record !== null && record.permissionMode === 'default', j(record))
  const loaded = await h.agent.request('session/load', { sessionId: sid, cwd: projDir, mcpServers: [] })
  check('session/load resumes in default', loaded.modes?.currentModeId === 'default', j(loaded.modes?.currentModeId))
  await h.agent.request('session/close', { sessionId: sid }).catch(() => {})
} catch (error) {
  check('the proof ran to its end', false, error instanceof Error ? error.message : String(error))
}
h.close()
server.kill('SIGKILL')
await api.close()

console.log('')
if (failures > 0) {
  console.log(`❌ acp modes: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ acp modes: the one list, and Sovereign only with consent')
