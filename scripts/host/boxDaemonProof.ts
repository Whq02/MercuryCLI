import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export async function proveBoxDaemon(bundle: string, home: string, model: string, register: () => Promise<void>): Promise<void> {
  const daemonDir = join(home, 'daemon-proof')
  const work = join(home, 'workspace')
  mkdirSync(daemonDir, { recursive: true }); mkdirSync(work, { recursive: true })
  process.env.MERCURY_DAEMON_DIR = daemonDir
  const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
  seedFirstRun(home, [work])
  const { saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
  saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 3 } }))
  const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
  const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
  const log = join(home, 'box-daemon.log')
  const fd = openSync(log, 'a')
  const child = spawn('node', [bundle, 'daemon', 'run', work], { cwd: work, stdio: ['ignore', fd, fd], env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: daemonDir, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_PARTY: '0', MERCURY_CACHE_CLOCK: '0', MERCURY_TERMINAL_TITLE: '0' } })
  closeSync(fd)
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  const until = async (predicate: () => boolean | Promise<boolean>, label: string): Promise<void> => {
    const end = Date.now() + 90_000
    for (;;) { try { if (await predicate()) return } catch {} if (Date.now() > end) throw new Error(label + '\n' + readFileSync(log, 'utf8').slice(-4000)); await delay(150) }
  }
  const rpc = (payload: unknown) => daemonControlRpc(payload as never, { timeoutMs: 30_000 }) as Promise<any>
  const transcript = (sid: string): string => { const path = join(getProjectDir(work), sid + '.jsonl'); return existsSync(path) ? readFileSync(path, 'utf8') : '' }
  const settled = (sid: string): boolean => {
    try {
      const workers = JSON.parse(readFileSync(join(daemonDir, 'concourse-workers.json'), 'utf8')).workers
      const row = Object.values(workers).find((w: any) => w.sessionId === sid && !w.endedAt) as any
      const facts = JSON.parse(readFileSync(join(daemonDir, 'session-facts', sid + '.json'), 'utf8'))
      return row && (row.lastTurnSettledAt ?? 0) >= (row.lastDeliveryAt ?? 1) && facts.busy === false
    } catch { return false }
  }
  const send = async (sid: string, prompt: string): Promise<void> => {
    const answer = await rpc({ op: 'sessionDispatch', clientMessageId: crypto.randomUUID(), prompt, workspaceDir: work, targetSessionId: sid })
    assert.equal(answer.ok, true, JSON.stringify(answer))
  }
  try {
    await until(async () => (await rpc({ op: 'ping' })).ok, 'daemon readiness')
    await register()
    const born = await rpc({ op: 'sessionAdmit', workspaceDir: work, isolation: 'shared', by: 'operator', bornBlank: true, model })
    assert.equal(born.ok, true, JSON.stringify(born)); assert.equal(born.modelId, model)
    await send(born.sessionId, '/model ' + model)
    await until(() => transcript(born.sessionId).includes(model) && settled(born.sessionId), 'new session selects the registered box model')
    await send(born.sessionId, 'Say ready from the model server.')
    await until(() => transcript(born.sessionId).includes('BOX-FIXTURE-READY') && settled(born.sessionId), 'new session serves a turn')
    const cleared = await rpc({ op: 'sessionAdmit', workspaceDir: work, isolation: 'shared', by: 'operator', bornBlank: true, model, vacatingSessionId: born.sessionId })
    assert.equal(cleared.ok, true, JSON.stringify(cleared)); assert.equal(cleared.modelId, model); assert.notEqual(cleared.sessionId, born.sessionId)
    const parked = await rpc({ op: 'sessionControl', action: 'park', sessionId: born.sessionId, by: 'operator:' + process.pid })
    assert.equal(parked.ok, true, JSON.stringify(parked))
    await send(cleared.sessionId, 'A turn after clear.')
    await until(() => transcript(cleared.sessionId).includes('BOX-FIXTURE-READY') && settled(cleared.sessionId), 'clear serves the same key-less model')
    console.log('MERCURY HOST GREEN · built daemon sees registration after boot; new session /model and clear answer key-less')
  } finally {
    await rpc({ op: 'shutdown', reapWorkers: true }).catch(() => {})
    if (!await Promise.race([exited.then(() => true), delay(10_000).then(() => false)])) { child.kill('SIGTERM'); await Promise.race([exited, delay(5000)]) }
  }
}
