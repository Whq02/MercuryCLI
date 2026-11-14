#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pinSourceRef } from '../lib/settingsPopupHarness.ts'

const scratch = process.env.MERCURY_CONFIG_DIR
assert(scratch, 'run with a scratch MERCURY_CONFIG_DIR')
if (process.env.SHARED_TURN_PROOF_HOME === undefined) {
  const own = mkdtempSync(join(scratch, 'shared-turn-home-'))
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, HOME: own, USERPROFILE: own, SHARED_TURN_PROOF_HOME: own } })
  rmSync(own, { recursive: true, force: true })
  process.exit(child.status ?? 1)
}
assert.equal(homedir(), process.env.SHARED_TURN_PROOF_HOME, 'the proof loads the product under its own scratch home')
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(scratch, 'shared-turn-config-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(scratch, 'shared-turn-daemon-'))
delete process.env.MERCURY_HOME
pinSourceRef()

const { makeTally, sleep } = await import('./crew-world.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
const notices = await import('../../src/services/engine-connector/queuedNotices.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
const { recordTranscript, flushSessionStorage } = await import('../../src/utils/sessionStorage.ts')
const { getTranscriptPathForSession } = await import('../../src/utils/sessionStorage/paths.ts')
const { wrapInSystemReminder } = await import('../../src/utils/messages/text.ts')

const tally = makeTally('notices-sharing-a-turn-land')
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the shared turn proof exceeded 180s')
  process.exit(1)
}, 180_000)
watchdog.unref?.()

type Message = Parameters<typeof notices.noticeRowLanded>[0]
type Fact = { value: string; mode: string; priority?: string }
type Row = { uuid: string; type: string; timestamp: string; queued?: true; isMeta?: boolean; attachment?: Record<string, unknown>; message?: { content?: unknown } }
type Guts = { attached: boolean; tick: () => Promise<void>; reconcileQueuedSends: (facts: unknown) => void }

const ALPHA = '<monitor task="bk1" name="Watch alpha">\nALPHA-LINE\n</monitor>'
const BRAVO = '<monitor task="bk2" name="Watch bravo">\nBRAVO-LINE\n</monitor>'
const HOOK = wrapInSystemReminder('hook lint (Stop) blocked: 3 errors')
const TASK = '<task-notification>\n<task-id>t-done</task-id>\n<status>completed</status>\n<summary>Background command "the build" completed (exit code 0)</summary>\n</task-notification>'
const ABSENT = '<monitor task="bk3" name="Watch charlie">\nCHARLIE-LINE\n</monitor>'
const blocks = (...texts: string[]): Array<{ type: 'text'; text: string }> => texts.map(text => ({ type: 'text', text }))
const j = (value: unknown): string => JSON.stringify(value)

tally.section('§1 the landing test: a notice lands on the row that holds it as one of its text blocks')
{
  const at = Date.now()
  const stamp = (offsetMs: number): string => new Date(at + offsetMs).toISOString()
  const row = (content: unknown, extra: Record<string, unknown> = {}): Message => ({ type: 'user', uuid: 'row', timestamp: stamp(200), message: { role: 'user', content }, ...extra }) as unknown as Message
  const shared = row(blocks(ALPHA, BRAVO))
  tally.check('two monitor lines taken into one turn are one row of two text blocks: the first lands on it (the parent compares the row\'s whole text and lands neither)', notices.noticeRowLanded(shared, ALPHA, at), j(shared))
  tally.check('…and so does the second', notices.noticeRowLanded(shared, BRAVO, at))
  tally.check('a hook\'s notice beside a monitor line lands the same way', notices.noticeRowLanded(row(blocks(ALPHA, HOOK)), HOOK, at) && notices.noticeRowLanded(row(blocks(HOOK, ALPHA)), ALPHA, at))
  tally.check('a notice that is not one of the row\'s blocks never lands on it', !notices.noticeRowLanded(shared, ABSENT, at) && !notices.noticeRowLanded(shared, HOOK, at))
  tally.check('a block that only quotes the notice inside other words does not land it', !notices.noticeRowLanded(row(blocks(`the watch said ${ALPHA} a moment ago`, BRAVO)), ALPHA, at))
  tally.check('a row older than the notice never lands it, shared or not', !notices.noticeRowLanded(row(blocks(ALPHA, BRAVO), { timestamp: stamp(-5000) }), ALPHA, at))
  tally.check('a hidden row never lands it', !notices.noticeRowLanded(row(blocks(ALPHA, BRAVO), { isMeta: true }), ALPHA, at))
  tally.check('alone in its row a notice lands as it did, as the row\'s text or as its one block', notices.noticeRowLanded(row(ALPHA), ALPHA, at) && notices.noticeRowLanded(row(blocks(ALPHA)), ALPHA, at) && !notices.noticeRowLanded(row(ALPHA), BRAVO, at))
  tally.check('a notice with a task id lands beside others as it did, by its id and its words', notices.noticeRowLanded(row(blocks(ALPHA, TASK)), TASK, at) && !notices.noticeRowLanded(row(blocks(ALPHA, TASK.replace('t-done', 't-other'))), TASK, at))
}

tally.section('§2 the window: notices taken into one turn leave no row of the window\'s own beside the record\'s')
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
  const windowRows = (value: string): Row[] => rows().filter(row => row.type === 'attachment' && row.attachment?.type === 'queued_command' && row.attachment.commandMode === 'task-notification' && row.attachment.prompt === value)
  const recordRows = (value: string): Row[] => rows().filter(row => row.type === 'user' && row.isMeta !== true && (row.message?.content === value || (Array.isArray(row.message?.content) && (row.message.content as Array<{ text?: string }>).some(block => block.text === value))))
  const fact = (value: string): Fact => ({ value, mode: 'task-notification', priority: 'next' })
  await write([createUserMessage({ content: 'watch the two files' }), createAssistantMessage({ content: 'watching' })])

  g.reconcileQueuedSends(facts([fact(ALPHA), fact(BRAVO)]))
  tally.check('two monitor lines queued together: the window holds one row for each', windowRows(ALPHA).length === 1 && windowRows(BRAVO).length === 1 && windowRows(ALPHA)[0]!.queued === true && windowRows(BRAVO)[0]!.queued === true, j([windowRows(ALPHA).length, windowRows(BRAVO).length]))
  await sleep(15)
  g.reconcileQueuedSends(facts([]))
  tally.check('taken by the runner: each stands as a delivered row until the record lands it', windowRows(ALPHA).length === 1 && windowRows(BRAVO).length === 1 && windowRows(ALPHA)[0]!.queued !== true, j([windowRows(ALPHA).length, windowRows(BRAVO).length]))
  await write([createUserMessage({ content: blocks(ALPHA, BRAVO) }), createAssistantMessage({ content: 'both lines noted' })])
  tally.check('the record lands them as one row of two blocks', recordRows(ALPHA).length === 1 && recordRows(BRAVO).length === 1 && recordRows(ALPHA)[0]!.uuid === recordRows(BRAVO)[0]!.uuid, j(rows().map(row => row.type)))
  tally.check('…and the window keeps no row of its own for the first line (the parent keeps it, so the line paints twice until a fold)', windowRows(ALPHA).length === 0, `${windowRows(ALPHA).length} window row(s) beside the record's`)
  tally.check('…nor for the second', windowRows(BRAVO).length === 0, `${windowRows(BRAVO).length} window row(s) beside the record's`)

  g.reconcileQueuedSends(facts([fact(HOOK), fact(TASK), fact(ABSENT)]))
  await sleep(15)
  g.reconcileQueuedSends(facts([]))
  await write([createUserMessage({ content: blocks(HOOK, TASK) }), createAssistantMessage({ content: 'the hook and the task noted' })])
  tally.check('a hook\'s notice and a finished task taken into one turn both land on their row', windowRows(HOOK).length === 0 && windowRows(TASK).length === 0, j([windowRows(HOOK).length, windowRows(TASK).length]))
  tally.check('a notice the record has not landed stays the window\'s own row, still owed to the screen', windowRows(ABSENT).length === 1 && windowRows(ABSENT)[0]!.queued !== true, `${windowRows(ABSENT).length} row(s)`)
  await write([createUserMessage({ content: ABSENT }), createAssistantMessage({ content: 'the third line noted' })])
  tally.check('…until its own row lands it', windowRows(ABSENT).length === 0 && recordRows(ABSENT).length === 1, `${windowRows(ABSENT).length} window · ${recordRows(ABSENT).length} record`)
}

clearTimeout(watchdog)
tally.finish()
