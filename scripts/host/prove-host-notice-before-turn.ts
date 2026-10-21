import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pinSourceRef } from '../lib/settingsPopupHarness.ts'
import { hostRunner } from '../lib/runnerHost.ts'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

pinSourceRef()
if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const home = process.env.MERCURY_CONFIG_DIR
const cwd = join(home, 'workspace')
mkdirSync(cwd, { recursive: true })
seedFirstRun(home, [cwd])
const root = resolve(import.meta.dir, '../..')
const at = process.argv.indexOf('--bundle')
const bundle = resolve(at < 0 ? join(root, 'dist/mercury.mjs') : process.argv[at + 1]!)
const fixture = await startFixtureApi([{ kind: 'text', text: 'HOST-READY-SEEN' }, { kind: 'text', text: 'HOST-FAILURE-SEEN' }])
const sessionId = randomUUID()
const runner = hostRunner({
  dist: bundle, node: process.execPath.endsWith('/bun') ? Bun.which('node')! : process.execPath, home, cwd,
  argv: ['--session-id', sessionId],
  env: { HOME: home, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_CONCOURSE_WORKER: '1', MERCURY_SESSION_KIND: 'oculus', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: fixture.url, BROWSER: '/usr/bin/true' },
})
try {
  await runner.initialize()
  const { hostNotice, deliverHostNotices } = await import('../../src/services/host/notices.ts')
  const { getCommandQueue, resetCommandQueue } = await import('../../src/utils/messageQueueManager.ts')
  const { isHeldNotice } = await import('../../src/input-core/command-queue.ts')
  const { taskNoticeBlock } = await import('../../src/utils/messages/noticeRows.ts')
  const record = { id: 'notice-pod', generation: 'notice-generation', sessionId, name: 'notice pod', recipe: 'fixture', price: 1, startedAt: new Date().toISOString(), status: 'RUNNING' }
  const ready = 'HOST-READY-BEFORE-FIRST-PROMPT · model is ready · /model compat/fixture/model'
  hostNotice(record, 'ready', ready)
  const visible = await runner.waitFor('ready notice paints in a blank hosted session without an operator prompt', row => row.type === 'task' && row.summary === ready, 12000)
  assert.equal(visible.status, 'completed')
  await runner.waitFor('ready notice wakes the model without operator input', row => row.type === 'outcome', 20000)
  assert.equal(fixture.messageRequests().length, 1, 'the settled ready notice starts exactly one model request')
  hostNotice(record, 'failed', 'HOST-FAILURE-BEFORE-FIRST-PROMPT · setup stopped')
  const failed = await runner.waitFor('failure notice also paints before the first prompt', row => row.type === 'task' && row.summary === 'HOST-FAILURE-BEFORE-FIRST-PROMPT · setup stopped', 12000)
  assert.equal(failed.status, 'failed')
  await runner.waitFor('failure notice wakes the model once when it arrives', () => runner.rows.filter(row => row.type === 'outcome').length === 2, 20000)
  assert.equal(fixture.messageRequests().length, 2, 'two settled notices make two timely turns, not a deferred batch')
  assert.equal(runner.rows.filter(row => row.type === 'task' && row.summary === ready).length, 1)
  assert.equal(runner.rows.filter(row => row.type === 'task' && row.summary === failed.summary).length, 1)
  resetCommandQueue()
  const own = { ...record, sessionId: 'classification-only' }
  for (const kind of ['ready', 'failed', 'rented', 'expired', 'ended']) hostNotice({ ...own, generation: kind }, kind, kind + ' message')
  deliverHostNotices(own.sessionId)
  const messages = getCommandQueue().filter(row => row.mode === 'task-notification')
  assert.equal(messages.length, 5)
  for (const command of messages) {
    assert.ok(isHeldNotice(command), 'every completed host event stays on the notice road')
    assert.ok(taskNoticeBlock(String(command.value)))
  }
  deliverHostNotices(own.sessionId)
  assert.equal(getCommandQueue().length, 5, 'reopening does not deliver a notice twice')
  assert.equal(fixture.messageRequests().length, 2)
  console.log('HOST NOTICE BEFORE TURN GREEN · blank built runner paints ready and failed notices before first input, each wakes the model once, and delivery never repeats')
} finally { await runner.stop(); await fixture.close() }
