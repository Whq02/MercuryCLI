#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) { console.error(`FAIL run bundle exists: ${dist}`); process.exit(1) }
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`); if (!ok) failures++ }
for (const road of ['success', 'failure', 'startup', 'usage', 'SIGINT', 'SIGTERM', 'stdin-SIGINT', 'stdin-SIGTERM'] as const) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'run-exit-')))
  seedFirstRun(home, [home])
  const turn: ScriptedTurn = road === 'failure' ? { kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'The fixture refuses this request.' } : road.startsWith('SIG') ? { kind: 'hang', deltas: ['The turn is open.'] } : { kind: 'text', text: 'The turn ended.' }
  const api = await startFixtureApi([turn])
  const stdinSignal = road.startsWith('stdin-') ? road.slice(6) : undefined
  const preload = join(home, 'input-signal.cjs')
  if (stdinSignal) writeFileSync(preload, `const on = process.stdin.on.bind(process.stdin); let sent = false; process.stdin.on = function(event, listener) { const value = on(event, listener); if (event === 'data' && !sent) { sent = true; setImmediate(() => process.kill(process.pid, ${JSON.stringify(stdinSignal)})); } return value; };`)
  const args = [...(road === 'startup' ? ['--project-root', join(home, 'absent')] : []), 'run', stdinSignal ? '-' : 'hello', '--format', 'rows', ...(road === 'usage' ? ['--max-turns', '0'] : [])]
  const child = spawn('node', [...(stdinSignal ? ['--require', preload] : []), dist, ...args], { cwd: home, env: { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: api.url }, stdio: [stdinSignal ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
  let out = '', err = '', buffer = '', finalAt = 0
  child.stdout.on('data', data => {
    const text = String(data)
    out += text
    buffer += text
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      try { if (JSON.parse(line).type === 'result') finalAt = performance.now() } catch {}
    }
  })
  child.stderr.on('data', data => { err += String(data) })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000)
  const closed = new Promise<{ code: number | null; endedAt: number }>(resolve => child.on('close', code => resolve({ code, endedAt: performance.now() })))
  if (road === 'SIGINT' || road === 'SIGTERM') void api.messageRequestStarted(1).then(() => { child.kill(road) })
  try {
    const { code, endedAt } = await closed
    const expected = road === 'success' ? 0 : road === 'usage' ? 2 : road.endsWith('SIGINT') ? 130 : road.endsWith('SIGTERM') ? 143 : 1
    let rows: Array<Record<string, unknown>> = []
    try { rows = out.trim().split('\n').map(line => JSON.parse(line)) } catch {}
    const results = rows.filter(row => row.type === 'result')
    check(`${road} exits ${expected}`, code === expected, JSON.stringify({ code, out, err }))
    check(`${road} ends with one final result row`, results.length === 1 && rows.at(-1)?.type === 'result', out)
    check(`${road} flushes its result before a bounded cleanup`, finalAt > 0 && endedAt - finalAt < 8_000, JSON.stringify({ finalAt, endedAt }))
    if (road !== 'success') check(`${road} carries an error outcome`, results[0]?.is_error === true, JSON.stringify(results[0]))
  } finally {
    clearTimeout(timeout)
    await api.close()
    rmSync(home, { recursive: true, force: true })
  }
}
process.exit(failures === 0 ? 0 : 1)
