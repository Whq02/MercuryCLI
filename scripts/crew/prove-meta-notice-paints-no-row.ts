#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scratch = process.env.MERCURY_CONFIG_DIR
assert(scratch, 'run with a scratch MERCURY_CONFIG_DIR')
if (process.env.META_NOTICE_PROOF_HOME === undefined) {
  const own = mkdtempSync(join(scratch, 'meta-notice-home-'))
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, HOME: own, USERPROFILE: own, META_NOTICE_PROOF_HOME: own } })
  rmSync(own, { recursive: true, force: true })
  process.exit(child.status ?? 1)
}
assert.equal(homedir(), process.env.META_NOTICE_PROOF_HOME, 'the proof loads the product under its own scratch home')
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(scratch, 'meta-notice-config-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(scratch, 'meta-notice-daemon-'))
delete process.env.MERCURY_HOME

const { DIST, NODE, LEAD_MODEL, closeWorld, findFiles, makeTally, makeWorld, sleep } = await import('./crew-world.ts')
const { hostRunner } = await import('../lib/runnerHost.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
const notices = await import('../../src/services/engine-connector/queuedNotices.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
const { recordTranscript, flushSessionStorage } = await import('../../src/utils/sessionStorage.ts')
const { getTranscriptPathForSession } = await import('../../src/utils/sessionStorage/paths.ts')
const { BOARD_PACKET_RULE } = await import('../../src/services/crewBoard/contracts.ts')
const { open } = await import('../../src/services/crewBoard/store.ts')
const { wrapInSystemReminder } = await import('../../src/utils/messages/text.ts')

const tally = makeTally('meta-notice-paints-no-row')
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the meta notice proof exceeded 240s')
  process.exit(1)
}, 240_000)
watchdog.unref?.()

type Fact = { value: string; mode: string; isMeta?: true; origin?: Record<string, unknown>; priority?: string; uuid?: string }
type Row = { uuid: string; type: string; timestamp: string; queued?: true; isMeta?: boolean; attachment?: Record<string, unknown>; message?: { content?: unknown } }
type Guts = { sends: unknown[]; echoRows: Map<string, unknown>; attached: boolean; tick: () => Promise<void>; reconcileQueuedSends: (facts: unknown) => void }

const WAKE = wrapInSystemReminder('Read reference-only posts with CrewBoard.')
const HELD_WAKE = wrapInSystemReminder(BOARD_PACKET_RULE)
const TASK = '<task-notification>\n<task-id>t-shown</task-id>\n<status>completed</status>\n<summary>Background command "the build" completed (exit code 0)</summary>\n</task-notification>'
const MONITOR = '<monitor task="bk1" name="the build watch">\nevent-1\n</monitor>'
const HOOK = wrapInSystemReminder('hook lint (Stop) blocked: 3 errors')
const REPORT = 'The nightly run is green.'
const REPORT_ORIGIN = { kind: 'outside-report', sender: 'ci', via: 'mcp-server' }

tally.section('§1 the window: a meta item of the queue facts makes no row, queued or taken; every other notice makes the row it made')
{
  const sid = bootstrap.getSessionId()
  const home = dirname(getTranscriptPathForSession(sid))
  const connector = new DaemonSessionConnector({ sessionId: sid, home, workspaceId: '/tmp', title: 'rig', projectLabel: 'p' } as never)
  const g = connector as unknown as Guts
  const rows = (): Row[] => connector.records() as unknown as Row[]
  const facts = (queue: Fact[]): unknown => ({ schema: 1, sessionId: sid, atMs: Date.now(), busy: queue.length > 0, runnerGeneration: 1, queue, pendingModel: null })
  const write = async (records: unknown[]): Promise<void> => {
    await recordTranscript(records as never)
    await flushSessionStorage()
    g.attached = true
    await g.tick.call(connector)
    g.attached = false
  }
  const isNotice = (row: Row): boolean => row.type === 'attachment' && row.attachment?.type === 'queued_command' && row.attachment.commandMode === 'task-notification'
  const noticesOf = (): Row[] => rows().filter(isNotice)
  const rowsFor = (value: string): Row[] => noticesOf().filter(row => row.attachment?.prompt === value)
  const bare = (row: Row): unknown => {
    const { uuid: _uuid, timestamp: _timestamp, ...rest } = row
    const { sentAt: _sentAt, deliveredAt: _deliveredAt, ...attachment } = rest.attachment ?? {}
    return { ...rest, attachment }
  }
  const j = (value: unknown): string => JSON.stringify(value)
  await write([createUserMessage({ content: 'wait for the crew' }), createAssistantMessage({ content: 'waiting' })])

  tally.check('the window\'s reader of the queue facts knows the mark: a task-notification is a notice, a meta one is not, a prompt never was', notices.isNoticeFact({ mode: 'task-notification' }) && !notices.isNoticeFact({ mode: 'task-notification', isMeta: true }) && !notices.isNoticeFact({ mode: 'prompt' }) && !notices.isNoticeFact({ mode: 'prompt', isMeta: true }))
  for (const [name, value] of [['the wake with its advice', WAKE], ['the wake that is the rule alone', HELD_WAKE]] as const) {
    g.reconcileQueuedSends(facts([{ value, mode: 'task-notification', priority: 'next', isMeta: true }]))
    tally.check(`${name}, queued and marked meta: the window makes no row and keeps no send for it (the parent paints it held)`, rowsFor(value).length === 0 && g.sends.length === 0 && g.echoRows.size === 0, `${rowsFor(value).length} notice row(s) · ${g.sends.length} send(s)`)
    await sleep(15)
    g.reconcileQueuedSends(facts([]))
    tally.check(`${name}, taken: still no row (the parent leaves a delivered notice)`, rowsFor(value).length === 0, j(rowsFor(value).map(bare)))
    await write([createUserMessage({ content: value, isMeta: true }), createAssistantMessage({ content: `reply to ${name}` })])
    tally.check(`${name}, recorded as its hidden row: the window holds the record and nothing of its own`, rowsFor(value).length === 0 && rows().filter(row => row.type === 'user' && row.isMeta === true && row.message?.content === value).length === 1, j(rows().map(row => row.type)))
  }

  const kinds: Array<[string, Fact]> = [
    ['a finished task', { value: TASK, mode: 'task-notification', priority: 'next' }],
    ['a monitor line', { value: MONITOR, mode: 'task-notification', priority: 'next' }],
    ['a hook that blocked', { value: HOOK, mode: 'task-notification' }],
    ['an outside report', { value: REPORT, mode: 'task-notification', origin: REPORT_ORIGIN, priority: 'next' }],
  ]
  for (const [name, fact] of kinds) {
    const origin = fact.origin === undefined ? {} : { origin: fact.origin }
    g.reconcileQueuedSends(facts([fact]))
    const held = rowsFor(fact.value)
    tally.check(`${name}, not meta, queued: one held row of the shape it had`, held.length === 1 && j(bare(held[0]!)) === j({ type: 'attachment', attachment: { type: 'queued_command', prompt: fact.value, commandMode: 'task-notification', ...origin }, queued: true }), j(held.map(bare)))
    await sleep(15)
    g.reconcileQueuedSends(facts([]))
    const taken = rowsFor(fact.value)
    tally.check(`${name}, taken: one delivered row of the shape it had`, taken.length === 1 && j(bare(taken[0]!)) === j({ type: 'attachment', attachment: { type: 'queued_command', prompt: fact.value, commandMode: 'task-notification', ...origin } }) && typeof taken[0]!.attachment?.deliveredAt === 'string', j(taken.map(bare)))
    await write([createUserMessage({ content: fact.value, ...(fact.origin === undefined ? {} : { origin: fact.origin as never }) }), createAssistantMessage({ content: `noted ${name}` })])
    tally.check(`${name}, recorded: its own row lands it and the window keeps none of its own`, rowsFor(fact.value).length === 0, j(rowsFor(fact.value).map(bare)))
  }

  const BESIDE = TASK.replace('t-shown', 't-beside')
  g.reconcileQueuedSends(facts([{ value: WAKE, mode: 'task-notification', priority: 'next', isMeta: true }, { value: BESIDE, mode: 'task-notification', priority: 'next' }]))
  tally.check('a wake queued beside a finished task: the task\'s held row stands and the wake has none', rowsFor(BESIDE).length === 1 && rowsFor(BESIDE)[0]!.queued === true && rowsFor(WAKE).length === 0, j(noticesOf().map(bare)))
  g.reconcileQueuedSends(facts([]))
  tally.check('the window holds no notice row of a wake at the end', rowsFor(WAKE).length === 0 && rowsFor(HELD_WAKE).length === 0, `${rowsFor(WAKE).length} · ${rowsFor(HELD_WAKE).length}`)
}

tally.section('§2 the runner: the queue facts mark a meta item and leave every other item as it was')
{
  assert(existsSync(DIST), `build first or pass --dist: ${DIST}`)
  const world = await makeWorld('meta-notice-facts', [
    { kind: 'text', text: 'Lead is waiting.' },
    { kind: 'text', text: 'WAKE-REPLY.' },
    { kind: 'tool_use', name: 'Bash', input: { command: 'sleep 2; echo job-done', description: 'Print job-done after a while', run_in_background: true } },
    { kind: 'text', text: 'Job started.' },
    { kind: 'text', text: 'JOB-REPLY.' },
  ])
  const settings = join(world.config, 'settings.json')
  writeFileSync(settings, JSON.stringify({ ...(existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {}), swarm: { enabled: true } }))
  let raw = ''
  const host = hostRunner({ dist: DIST, node: NODE, cwd: world.project, home: world.config, env: { ...world.env, MERCURY_SETTLE_WINDOW_MS: '4000' } as Record<string, string | undefined>, argv: ['--model', LEAD_MODEL, '--allowed-tools', 'Bash', 'CrewBoard'], raw: line => { raw += line } })
  const until = async (label: string, test: () => boolean, timeoutMs = 90_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (!test()) {
      if (Date.now() > deadline) throw new Error(`${label}\n--- rows tail ---\n${raw.slice(-1500)}\n--- stderr tail ---\n${host.stderr().slice(-1000)}`)
      await sleep(25)
    }
  }
  const answered = async (label: string, from: number, answer: string): Promise<void> => until(label, () => raw.slice(from).includes(answer) && raw.slice(raw.indexOf(answer, from)).includes('"type":"outcome"'))
  const prompt = async (text: string, answer: string): Promise<void> => {
    const from = raw.length
    await host.prompt(text)
    await answered(`${text} answered`, from, answer)
  }
  const queuedNotice = async (holding: string): Promise<Fact | undefined> => {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) {
      const facts = await host.request('session/facts', {}) as unknown as { queue?: Fact[] }
      const item = (facts.queue ?? []).find(entry => entry.mode === 'task-notification' && entry.value.includes(holding))
      if (item !== undefined) return item
      await sleep(150)
    }
    return undefined
  }
  let board: ReturnType<typeof open> | undefined
  try {
    await host.initialize({})
    await prompt('/swarm on', 'Swarm on for new crewmates')
    await prompt('Wait for crew questions.', 'Lead is waiting.')
    await sleep(500)
    const sessionId = String(host.rows.find(row => row.type === 'session')?.session_id ?? '')
    const path = findFiles(world.config, 'board.sqlite').find(candidate => candidate.includes(sessionId))!
    board = open(path, basename(dirname(dirname(dirname(path)))))
    const sender = { author: { sessionId: basename(dirname(dirname(dirname(path)))), agentId: 'poster', executionId: 'run' }, name: 'poster' }
    board.enroll(sender)
    const woken = raw.length
    assert(board.post(sender, { clientOpId: 'ask', kind: 'ask', text: '@main FACTS-ASK which file first?' }).ok)
    const wake = await queuedNotice('Read reference-only posts with CrewBoard.')
    tally.check('a queued wake stands in the queue facts, so a host can still count it', wake !== undefined, JSON.stringify(wake))
    tally.check('…and it carries the mark: isMeta true (the parent\'s facts carry none)', wake?.isMeta === true, JSON.stringify(wake))
    tally.check('…beside the keys it had and no other', JSON.stringify(Object.keys(wake ?? {}).sort()) === JSON.stringify(['isMeta', 'mode', 'priority', 'value']), JSON.stringify(Object.keys(wake ?? {}).sort()))
    await answered('the wake was answered', woken, 'WAKE-REPLY.')
    const started = raw.length
    await host.prompt('start the job')
    await answered('the job started', started, 'Job started.')
    const job = await queuedNotice('job-done')
    tally.check('a queued notice that is not meta, a finished job, stands in the queue facts as it did', job !== undefined && job.value.includes('<task-notification>'), JSON.stringify(job).slice(0, 300))
    tally.check('…with no mark and exactly the keys it had', job !== undefined && !('isMeta' in job) && JSON.stringify(Object.keys(job).sort()) === JSON.stringify(['mode', 'priority', 'value']), JSON.stringify(Object.keys(job ?? {}).sort()))
    await answered('the finished job was answered', started, 'JOB-REPLY.')
    host.end()
    await host.stop(30_000)
  } finally {
    board?.close()
    await host.stop(5_000)
    await closeWorld(world)
  }
}

clearTimeout(watchdog)
tally.finish()
