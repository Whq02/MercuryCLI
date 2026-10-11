import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'live-session-identity-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
delete process.env.MERCURY_HOME
try {
  const { getProcessStartTokenCachedOrRefresh } = await import('../../src/daemon/ownerWatch.ts')
  const { liveSessions, sessionWorkersFile } = await import('../../src/mneme/ledger.ts')
  const { mnemeProjectKeyFor } = await import('../../src/mneme/paths.ts')
  const deadline = Date.now() + 5000
  let token = getProcessStartTokenCachedOrRefresh(process.pid)
  while (token === null && Date.now() < deadline) {
    await Bun.sleep(20)
    token = getProcessStartTokenCachedOrRefresh(process.pid)
  }
  assert.ok(token, 'the live process identity probe settled')
  const base = { pid: process.pid, workspaceId: home, spawnedAt: Date.now() }
  const file = sessionWorkersFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ version: 1, workers: {
    live: { ...base, sessionId: 'live', procStart: token },
    reused: { ...base, sessionId: 'stale', procStart: 'another process start' },
    old: { ...base, sessionId: 'without-token' },
  } }))
  assert.deepEqual(liveSessions(mnemeProjectKeyFor(home)).map(row => row.sessionId).sort(), ['live', 'without-token'], 'a stale record whose PID belongs to another process is not live')
  console.log('LIVE SESSION IDENTITY GREEN')
} finally {
  rmSync(home, { recursive: true, force: true })
}
