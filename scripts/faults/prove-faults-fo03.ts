#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}
const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function scratch(tag: string): string {
  return mkdtempSync(join(tmpdir(), `faults-fo03-${tag}-`))
}

function runChild(body: string, timeoutMs = 8000): { timedOut: boolean; out: string } {
  const dir = scratch('child')
  const file = join(dir, 'child.ts')
  writeFileSync(file, body)
  const r = spawnSync(BUN, [file], { encoding: 'utf8', timeout: timeoutMs, env: { ...process.env } })
  return { timedOut: r.error !== undefined || r.signal !== null, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const BOX = join(SRC, 'daemon/saturn/saturnBoxSchedules.ts')
const HELD = `{ scheduleId: 'bbbbbbbb', dueAt: 1, reason: 'unreachable', envelope: { kind: 'birth', birth: {} }, heldAt: 1 }`

console.log('saturnBoxSchedules')
{
  const dir = scratch('box-eloop')
  let symCreated = true
  try {
    symlinkSync(join(dir, 'saturn-box-schedules.json.lock'), join(dir, 'saturn-box-schedules.json.lock'))
  } catch (err) {
    if (process.platform === 'win32' && (err as NodeJS.ErrnoException | null)?.code === 'EPERM') {
      symCreated = false
    } else {
      throw err
    }
  }
  if (!symCreated) {
    skip('box-lock-stat-fails: an unreadable lock throws instead of spinning', 'not read on Windows: no symlink privilege')
  } else {
    const r = runChild(`import { removeBoxSchedule } from ${JSON.stringify(BOX)}
try { console.log('RESULT', removeBoxSchedule('aaaaaaaa', ${JSON.stringify(dir)})) } catch (e) { console.log('THREW', (e as NodeJS.ErrnoException).code) }`)
    check('box-lock-stat-fails: an unreadable lock throws instead of spinning', !r.timedOut && /THREW ELOOP/.test(r.out), `${r.timedOut ? 'spun past the timeout' : r.out.slice(0, 200)} — withBoxLock in src/daemon/saturn/saturnBoxSchedules.ts (used by removeBoxSchedule) must throw the stat error, ELOOP here, when the lock cannot be statted, not retry`)
  }
}
{
  const dir = scratch('box-enotdir')
  const lock = join(dir, 'saturn-box-schedules.json.lock')
  writeFileSync(lock, 'x')
  utimesSync(lock, new Date(0), new Date(0))
  const r = runChild(`import { removeBoxSchedule } from ${JSON.stringify(BOX)}
try { console.log('RESULT', removeBoxSchedule('aaaaaaaa', ${JSON.stringify(dir)})) } catch (e) { console.log('THREW', (e as NodeJS.ErrnoException).code) }`)
  const expectedBreakCode = process.platform === 'win32' ? 'ENOENT' : 'ENOTDIR'
  check('box-lock-break-fails: a stale lock that cannot be removed throws instead of spinning', !r.timedOut && new RegExp(`THREW ${expectedBreakCode}\\b`).test(r.out), `${r.timedOut ? 'spun past the timeout' : r.out.slice(0, 200)} — withBoxLock in src/daemon/saturn/saturnBoxSchedules.ts (used by removeBoxSchedule) must throw the error from removing a stale lock, ${expectedBreakCode} here, not retry`)
}
{
  const dir = scratch('box-corrupt')
  const path = join(dir, 'saturn-box-schedules.json')
  writeFileSync(path, '{"version":1,"schedules":[{"id":"cccccccc"')
  const r = runChild(`import { holdBoxFire } from ${JSON.stringify(BOX)}
try { console.log('RESULT', holdBoxFire(${HELD}, ${JSON.stringify(dir)})) } catch (e) { console.log('THREW', (e as Error).name) }`)
  check('box-read-corrupt-hold: a corrupt box file is not replaced by a hold', /THREW SyntaxError/.test(r.out), `${r.out.slice(0, 200)} — holdBoxFire in src/daemon/saturn/saturnBoxSchedules.ts must throw on a corrupt box file instead of writing a hold over it`)
  check('box-read-corrupt-file-kept: the corrupt file still stands as written', readFileSync(path, 'utf8') === '{"version":1,"schedules":[{"id":"cccccccc"', 'holdBoxFire in src/daemon/saturn/saturnBoxSchedules.ts rewrote the corrupt box file; it must leave it untouched')
  const add = runChild(`import { addBoxSchedule } from ${JSON.stringify(BOX)}
const deps = { deriveAccount: () => ({ ok: true, account: { family: 'anthropic', source: 'api-key' } }) }
const sub = { when: { kind: 'at', atMs: Date.now() + 3_600_000, spelling: 'in 1h' }, action: { kind: 'birth', birth: { workspaceDir: '/w', modelKey: 'claude-opus-5', presence: 'headless' } } }
try { console.log('ADD', JSON.stringify(addBoxSchedule(sub, 'fixture', deps as never, ${JSON.stringify(dir)}))) } catch (e) { console.log('THREW', (e as Error).name) }`)
  check('box-add-corrupt-refused: adding over a corrupt box file answers schedule refused, no throw', /ADD \{"ok":false,"reason":"schedule refused — /.test(add.out), `${add.out.slice(0, 200)} — addBoxSchedule in src/daemon/saturn/saturnBoxSchedules.ts must answer { ok: false, reason: 'schedule refused — ...' } over a corrupt box file, not throw`)
  check('box-add-corrupt-file-kept: the corrupt file still stands after the add', readFileSync(path, 'utf8') === '{"version":1,"schedules":[{"id":"cccccccc"', 'addBoxSchedule in src/daemon/saturn/saturnBoxSchedules.ts rewrote the corrupt box file; it must leave it untouched')
}
if (POSIX_MODES) {
  const dir = scratch('box-eacces')
  const path = join(dir, 'saturn-box-schedules.json')
  const body = JSON.stringify({ version: 1, schedules: [], heldFires: [] })
  writeFileSync(path, body)
  chmodSync(path, 0o000)
  const r = runChild(`import { holdBoxFire } from ${JSON.stringify(BOX)}
try { console.log('RESULT', holdBoxFire(${HELD}, ${JSON.stringify(dir)})) } catch (e) { console.log('THREW', (e as NodeJS.ErrnoException).code) }`)
  chmodSync(path, 0o600)
  check('box-read-eacces-hold: an unreadable box file throws EACCES, not held over it', /THREW EACCES/.test(r.out), `${r.out.slice(0, 200)} — holdBoxFire in src/daemon/saturn/saturnBoxSchedules.ts must throw EACCES when the box file cannot be read, not hold over it`)
  check('box-read-eacces-file-kept: the unreadable file still stands as written', readFileSync(path, 'utf8') === body, 'holdBoxFire in src/daemon/saturn/saturnBoxSchedules.ts rewrote the unreadable box file; it must leave it untouched')
}

console.log('mcp needsAuth')
if (POSIX_MODES) {
  const NEEDS = join(SRC, 'integrations/mcp/client/needsAuth.ts')
  for (const road of ['clear', 'forget'] as const) {
    const home = scratch(`needs-${road}`)
    const cache = join(home, 'mcp-needs-auth-cache.json')
    writeFileSync(cache, JSON.stringify({ srv: { timestamp: Date.now() } }))
    chmodSync(cache, 0o400)
    chmodSync(home, 0o500)
    const call = road === 'clear' ? 'm.clearMcpAuthCache(); await new Promise(r => setTimeout(r, 100))' : "await m.forgetMcpNeedsAuth('srv')"
    const r = runChild(`process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
const m = await import(${JSON.stringify(NEEDS)})
console.log('BEFORE', await m.isNeedsAuthWarm('srv'))
${call}
console.log('AFTER', await m.isNeedsAuthWarm('srv'))`)
    chmodSync(home, 0o700)
    check(`needs-auth-${road}-unwritten: a ${road} the cache file refuses no longer reads the server as needing auth`, /BEFORE true/.test(r.out) && /AFTER false/.test(r.out), `${r.out.slice(0, 200)} — clearMcpAuthCache and forgetMcpNeedsAuth in src/integrations/mcp/client/needsAuth.ts must drop the server from the in-memory needs-auth state even when the cache file cannot be written`)
  }
}

console.log('sessionKit preset note')
{
  const CONFIG = join(SRC, 'platform/settings/config.ts')
  const PRESETS = join(SRC, 'integrations/mcp/presetStore.ts')
  const r = runChild(`import { mock } from 'bun:test'
const config = await import(${JSON.stringify(CONFIG)})
const presets = await import(${JSON.stringify(PRESETS)})
mock.module(${JSON.stringify(PRESETS)}, () => ({ ...presets, kitPresetDeltas: () => ({ ok: true, deltas: { mcpOff: ['srv'], skillStates: {}, extensionsOff: [] } }) }))
mock.module(${JSON.stringify(CONFIG)}, () => ({ ...config, getGlobalConfig: () => { throw new Error('EACCES: fixture') } }))
const { deriveSessionKitForPreset } = await import(${JSON.stringify(join(SRC, 'daemon/session-seat/sessionKit.ts'))})
console.log('NOTE', JSON.stringify(deriveSessionKitForPreset('p', '/w')))`)
  check('preset-census-unread: an MCP census that cannot be read is named in the preset note, not called servers this repo lacks', r.out.includes("this repo's MCP servers could not be read (EACCES: fixture)") && !r.out.includes('servers this repo lacks'), `${r.out.slice(0, 300)} — deriveSessionKitForPreset in src/daemon/session-seat/sessionKit.ts must word its note as "this repo's MCP servers could not be read (<error>)" when the global config read throws`)
}

console.log('claude.ai connectors')
{
  const AUTH = join(SRC, 'models/sign-in/credentials/auth.ts')
  const r = runChild(`import { mock } from 'bun:test'
process.env.MERCURY_ANTHROPIC_CONNECTORS = '1'
let calls = 0
const auth = await import(${JSON.stringify(AUTH)})
mock.module(${JSON.stringify(AUTH)}, () => ({ ...auth, getClaudeAIOAuthTokens: () => ({ accessToken: 'fixture', scopes: ['user:mcp_servers'] }) }))
mock.module('axios', () => ({ default: { get: async () => { calls++; throw new Error('ECONNRESET: fixture') } } }))
const m = await import(${JSON.stringify(join(SRC, 'integrations/mcp/anthropicConnectors.ts'))})
await m.fetchAnthropicConnectorsIfEligible()
await m.fetchAnthropicConnectorsIfEligible()
console.log('CALLS', calls)`)
  check('connectors-fetch-failed-retried: a failed connector fetch is asked again, not kept as no connectors', /CALLS 2/.test(r.out), `${r.out.slice(0, 300)} — fetchAnthropicConnectorsIfEligible in src/integrations/mcp/anthropicConnectors.ts must not keep a failed fetch as an empty result; the second call has to ask again`)
}

console.log(failures === 0 ? 'all rows pass' : `${failures} row(s) failed`)
process.exit(failures === 0 ? 0 : 1)
