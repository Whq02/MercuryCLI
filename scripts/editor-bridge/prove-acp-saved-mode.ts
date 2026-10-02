#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'acp-saved-mode-'))
const project = join(scratch, 'project')
mkdirSync(project)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
const { setOriginalCwd } = await import('../../src/bootstrap/state.ts')
setOriginalCwd(project)
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const { entryToRecord } = await import('../../src/fabric/entryCodec.ts')
const { ordinalOf } = await import('../../src/fabric/ordinal.ts')
const { asSessionId } = await import('../../src/types/ids.ts')
const { setAutoModeCircuitBroken } = await import('../../src/utils/permissions/autoModeState.ts')
const { runAcpServer } = await import('../../src/services/acp/acpServer.ts')
const storage = getProjectDir(project)
mkdirSync(storage, { recursive: true })
const fixture = join(scratch, 'child.mjs')
writeFileSync(fixture, `
import { createInterface } from 'node:readline'
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const arg = name => process.argv[process.argv.indexOf(name) + 1]
const sessionId = arg(process.argv.includes('--resume') ? '--resume' : '--session-id')
const mode = arg('--mode')
const bootPath = join(process.cwd(), sessionId + '.boot.json')
writeFileSync(bootPath + '.tmp', JSON.stringify({ mode, pid: process.pid }))
renameSync(bootPath + '.tmp', bootPath)
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line)
  if (frame.type !== 'control_request' || frame.request.subtype !== 'set_permission_mode') process.exit(23)
  const refused = existsSync(join(process.cwd(), 'refuse-mode'))
  process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: refused ? 'error' : 'success', request_id: frame.request_id } }) + '\\n')
}
`)

let failures = 0
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
}
async function deadline<T>(label: string, work: Promise<T>): Promise<T> {
  let alarm: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => { alarm = setTimeout(() => reject(new Error(`${label} did not settle`)), 60_000) }),
    ])
  } finally {
    clearTimeout(alarm)
  }
}
async function bootMode(sessionId: string): Promise<string> {
  const path = join(project, `${sessionId}.boot.json`)
  const until = Date.now() + 60_000
  while (!existsSync(path)) {
    if (Date.now() >= until) throw new Error('child boot receipt did not arrive')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return (JSON.parse(readFileSync(path, 'utf8')) as { mode: string }).mode
}
const live = new Set<() => Promise<void>>()
async function openServer() {
  const input = new PassThrough()
  const output = new PassThrough()
  const serving = runAcpServer({ input, output, entry: { node: process.execPath, script: fixture } })
  const updates: Array<Record<string, unknown>> = []
  const connection = client({ name: 'saved-mode-proof' })
    .onNotification('session/update', ctx => { updates.push(ctx.params.update as unknown as Record<string, unknown>) })
    .connect(ndJsonStream(Writable.toWeb(input) as WritableStream<Uint8Array>, Readable.toWeb(output) as ReadableStream<Uint8Array>))
  const agent = connection.agent
  const close = async () => {
    input.end()
    await deadline('server close', serving)
    connection.close()
    live.delete(close)
  }
  live.add(close)
  await deadline('initialize', agent.request('initialize', { protocolVersion: PROTOCOL_VERSION }))
  return { agent, updates, close }
}
function modeFields(response: { modes?: { currentModeId: string } | null; configOptions?: Array<{ id: string; currentValue: string }> | null }): unknown[] {
  return [response.modes?.currentModeId, response.configOptions?.find(option => option.id === 'permission-mode')?.currentValue]
}
async function load(sessionId: string, expected: string, label: string): Promise<void> {
  rmSync(join(project, `${sessionId}.boot.json`), { force: true })
  const server = await openServer()
  try {
    const [response, concurrent] = await deadline(label, Promise.all([
      server.agent.request('session/load', { sessionId, cwd: project, mcpServers: [] }),
      server.agent.request('session/load', { sessionId, cwd: project, mcpServers: [] }),
    ]))
    check(`${label}: client mode and config`, modeFields(response), [expected, expected])
    check(`${label}: concurrent load agrees`, modeFields(concurrent), [expected, expected])
    check(`${label}: one replay for concurrent loads`, server.updates.filter(update => update.sessionUpdate === 'user_message_chunk').length, existsSync(join(storage, `${sessionId}.jsonl`)) ? 1 : 0)
    check(`${label}: attached child mode`, await bootMode(sessionId), expected)
    const updates = server.updates.length
    const again = await deadline('idempotent load', server.agent.request('session/load', { sessionId, cwd: project, mcpServers: [] }))
    check(`${label}: repeated load`, modeFields(again), [expected, expected])
    check(`${label}: no replay on repeated load`, server.updates.length, updates)
  } finally {
    await server.close()
  }
}

try {
  const first = await openServer()
  const created = await deadline('session/new', first.agent.request('session/new', { cwd: project, mcpServers: [] }))
  const sessionId = created.sessionId
  check('session/new starts in default', modeFields(created), ['default', 'default'])
  check('session/new child starts in default', await bootMode(sessionId), 'default')
  const prompt = { type: 'user', uuid: randomUUID(), parentUuid: null, sessionId, timestamp: new Date().toISOString(), message: { role: 'user', content: 'earlier prompt' }, permissionMode: 'default' }
  const record = entryToRecord(prompt, { sessionId: asSessionId(sessionId), nextOrdinal: () => ordinalOf(1), observedAt: prompt.timestamp, source: { channel: 'sdk' } })
  writeFileSync(join(storage, `${sessionId}.jsonl`), `${JSON.stringify(record)}\n`)
  await deadline('set mode', first.agent.request('session/set_mode', { sessionId, modeId: 'implement' }))
  check('mode setter tells client', first.updates.some(update => update.sessionUpdate === 'current_mode_update' && update.currentModeId === 'implement'), true)
  await first.close()
  await load(sessionId, 'implement', 'fresh server restores saved implement')

  const second = await openServer()
  await deadline('load before config change', second.agent.request('session/load', { sessionId, cwd: project, mcpServers: [] }))
  await deadline('set config option', second.agent.request('session/set_config_option', { sessionId, configId: 'permission-mode', value: 'strategy' }))
  writeFileSync(join(project, 'refuse-mode'), '')
  let rejected = false
  try {
    await deadline('refused mode', second.agent.request('session/set_mode', { sessionId, modeId: 'flow' }))
  } catch { rejected = true }
  rmSync(join(project, 'refuse-mode'))
  check('child refusal reaches client', rejected, true)
  await second.close()
  await load(sessionId, 'strategy', 'latest acknowledged config value survives refused change')

  const third = await openServer()
  const empty = await deadline('empty session/new', third.agent.request('session/new', { cwd: project, mcpServers: [] }))
  await deadline('empty session mode', third.agent.request('session/set_mode', { sessionId: empty.sessionId, modeId: 'flow' }))
  await third.close()
  try {
    await load(empty.sessionId, 'flow', 'mode survives before the first model turn')
    setAutoModeCircuitBroken(true)
    try {
      await load(empty.sessionId, 'default', 'unavailable flow falls back to default')
    } finally {
      setAutoModeCircuitBroken(false)
    }
  } catch (error) {
    check('mode survives before the first model turn', String(error), 'successful load')
  }

  for (const [saved, expected] of [[undefined, 'default'], ['flow', 'flow'], ['acceptEdits', 'default'], ['bypassPermissions', 'default'], ['plan', 'default'], ['auto', 'default'], ['sovereign', 'default'], ['unknown-mode', 'default']] as const) {
    const id = randomUUID()
    const row = { type: 'user', uuid: randomUUID(), parentUuid: null, sessionId: id, timestamp: new Date().toISOString(), message: { role: 'user', content: 'saved prompt' }, ...(saved !== undefined ? { permissionMode: saved } : {}) }
    const record = entryToRecord(row, { sessionId: asSessionId(id), nextOrdinal: () => ordinalOf(1), observedAt: row.timestamp, source: { channel: 'sdk' } })
    writeFileSync(join(storage, `${id}.jsonl`), `${JSON.stringify(record)}\n`)
    await load(id, expected, `legacy transcript mode ${saved ?? '(absent)'}`)
  }
  const fourth = await openServer()
  await deadline('load before default change', fourth.agent.request('session/load', { sessionId, cwd: project, mcpServers: [] }))
  await deadline('return to default', fourth.agent.request('session/set_mode', { sessionId, modeId: 'default' }))
  await fourth.close()
  await load(sessionId, 'default', 'explicit default replaces previous saved mode')

  const last = await openServer()
  let missingRefused = false
  try {
    await deadline('missing session', last.agent.request('session/load', { sessionId: randomUUID(), cwd: project, mcpServers: [] }))
  } catch { missingRefused = true }
  check('unknown session is still refused', missingRefused, true)
  await last.close()
} finally {
  await Promise.all([...live].map(close => close()))
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`ACP saved mode: ${failures === 0 ? 'PASS' : 'FAIL'} (${failures} failures; no model turns)`)
process.exitCode = failures > 0 ? 1 : 0
