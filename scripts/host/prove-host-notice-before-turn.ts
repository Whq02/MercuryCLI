import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
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
  dist: bundle, node: /[\\/]bun(?:\.exe)?$/.test(process.execPath) ? Bun.which('node')! : process.execPath, home, cwd,
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
  const paused = 'HOST-PAUSED-BEFORE-FIRST-PROMPT · setup paused · $3.99/hr still billing · Resume or Terminate in /llmhost'
  hostNotice({ ...record, generation: 'paused-generation' }, 'paused', paused)
  const pausedRow = await runner.waitFor('a pause notice paints the same way', row => row.type === 'task' && row.summary === paused, 12000)
  assert.equal(pausedRow.status, 'stopped')
  hostNotice(record, 'failed', 'HOST-FAILURE-BEFORE-FIRST-PROMPT · setup stopped')
  const failed = await runner.waitFor('failure notice also paints before the first prompt', row => row.type === 'task' && row.summary === 'HOST-FAILURE-BEFORE-FIRST-PROMPT · setup stopped', 12000)
  assert.equal(failed.status, 'failed')
  const terminated = 'HOST-TERMINATED-BEFORE-FIRST-PROMPT · Machine terminated · its disk is deleted.'
  hostNotice({ ...record, generation: 'ended-generation' }, 'ended', terminated)
  await runner.waitFor('a terminate notice paints too', row => row.type === 'task' && row.summary === terminated, 12000)
  await new Promise(resolve => setTimeout(resolve, 6000))
  assert.equal(fixture.messageRequests().length, 0, 'a ready, a pause, a failure and a terminate notice make zero model requests')
  assert.equal(runner.rows.filter(row => row.type === 'outcome').length, 0, 'no turn opened for a host notice')
  assert.equal(runner.rows.filter(row => row.type === 'task' && row.summary === ready).length, 1)
  assert.equal(runner.rows.filter(row => row.type === 'task' && row.summary === failed.summary).length, 1)
  const transcripts = readdirSync(join(home, 'projects'), { recursive: true }).map(String).filter(name => name.endsWith(sessionId + '.jsonl'))
  assert.equal(transcripts.length, 1, 'the session transcript exists: ' + transcripts.join(', '))
  const recorded = readFileSync(join(home, 'projects', transcripts[0]!), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { actor?: { role?: string }; annotations?: { isVirtual?: boolean; origin?: { kind?: string } }; payload?: { kind?: string; content?: unknown } })
  const noticeRows = recorded.filter(row => row.payload?.kind === 'input' && typeof row.payload.content === 'string' && row.payload.content.includes('<task-id>host-'))
  assert.equal(noticeRows.length, 4, 'each notice is recorded once as a transcript row: ' + noticeRows.length)
  assert.ok(noticeRows.every(row => row.annotations?.isVirtual === true && row.annotations.origin?.kind === 'task-notification'), 'every recorded notice row is virtual on the notification lane: painted for the user, never sent to the model')
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
  assert.equal(fixture.messageRequests().length, 0)
  console.log('HOST NOTICE BEFORE TURN GREEN · blank built runner paints ready, paused, failed and terminate notices before first input, none wakes the model, each is recorded once, and delivery never repeats')
} finally { await runner.stop(); await fixture.close() }
