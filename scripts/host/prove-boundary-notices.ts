import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const childAt = process.argv.indexOf('--child')
if (childAt !== -1) {
  const { deliverHostNotices } = await import('../../src/services/host/notices.ts')
  const { getCommandQueue, remove, dequeue } = await import('../../src/input-core/command-queue.ts')
  const mode = process.argv[childAt + 1]
  deliverHostNotices('unrelated-session')
  const foreign = getCommandQueue().length
  deliverHostNotices('notice-session')
  deliverHostNotices('notice-session')
  const queued = getCommandQueue().length
  let recovered = 0
  if (mode === 'consume') dequeue()
  if (mode === 'remove') { remove(getCommandQueue()); deliverHostNotices('notice-session'); recovered = getCommandQueue().length }
  const markers = readdirSync(join(process.env.MERCURY_CONFIG_DIR!, 'host', 'notices')).filter(name => name.endsWith('.delivered')).length
  console.log(JSON.stringify({ queued, foreign, markers, recovered }))
  process.exit(0)
} else {
  const outer = process.env.MERCURY_CONFIG_DIR
  mkdirSync(outer, { recursive: true })
  const home = mkdtempSync(join(outer, 'notices-'))
  process.env.MERCURY_CONFIG_DIR = home
  delete process.env.MERCURY_HOME
  const { hostNotice } = await import('../../src/services/host/notices.ts')
  const record = { id: 'boundary-pod', generation: 'generation', sessionId: 'notice-session', name: 'Boundary pod', recipe: 'fixture', price: 0, startedAt: new Date().toISOString(), status: 'RUNNING' }
  let checks = 0
  let failures = 0
  const check = (name: string, truth: unknown) => { checks++; if (!truth) failures++; console.log((truth ? 'PASS ' : 'FAIL ') + name) }
  const child = (mode: string) => {
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', mode], { cwd: home, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true' }, encoding: 'utf8', timeout: 15000 })
    assert.equal(run.status, 0, run.stdout + run.stderr)
    return JSON.parse(run.stdout.trim().split('\n').at(-1)!)
  }
  try {
    hostNotice(record, 'ready', 'The model is ready')
    const first = child('leave-queued')
    check('a notice queues once and never enters another session', first.queued === 1 && first.foreign === 0)
    check('merely entering an in-memory queue does not claim durable consumption', first.markers === 0)
    const second = child('consume')
    check('a fresh process recovers a notice the earlier process never consumed', second.queued === 1 && second.foreign === 0)
    check('actual consumption acknowledges the durable notice', second.markers === 1)
    const third = child('leave-queued')
    check('an acknowledged notice is not delivered again after another restart', third.queued === 0 && third.markers === 1)
    hostNotice({ ...record, generation: 'cleared-generation' }, 'failed', 'The setup failed')
    const removed = child('remove')
    check('mid-turn consumption also acknowledges the notice without a duplicate', removed.queued === 1 && removed.recovered === 0 && removed.markers === 2)
    console.log('BOUNDARY NOTICES ' + (failures ? 'RED' : 'GREEN') + ' — ' + (checks - failures) + '/' + checks + '; four separate receiver processes, no network')
  } finally { process.env.MERCURY_CONFIG_DIR = outer; rmSync(home, { recursive: true, force: true }) }
  process.exitCode = failures ? 1 : 0
}
