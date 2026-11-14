#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scratch = process.env.MERCURY_CONFIG_DIR
assert(scratch, 'run with a scratch MERCURY_CONFIG_DIR')
if (process.env.FOLD_NOTICE_PROOF_HOME === undefined) {
  const own = mkdtempSync(join(scratch, 'fold-notice-home-'))
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, HOME: own, USERPROFILE: own, FOLD_NOTICE_PROOF_HOME: own } })
  rmSync(own, { recursive: true, force: true })
  process.exit(child.status ?? 1)
}
assert.equal(homedir(), process.env.FOLD_NOTICE_PROOF_HOME, 'the proof loads the product under its own scratch home')
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(scratch, 'fold-notice-config-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(scratch, 'fold-notice-daemon-'))
delete process.env.MERCURY_HOME

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
const { createCompactBoundaryMessage } = await import('../../src/utils/messages/systemMessages.ts')
const { recordTranscript, flushSessionStorage } = await import('../../src/utils/sessionStorage.ts')
const { getTranscriptPathForSession } = await import('../../src/utils/sessionStorage/paths.ts')
const { wrapInSystemReminder } = await import('../../src/utils/messages/text.ts')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the fold proof exceeded 90s')
  process.exit(1)
}, 90_000)
watchdog.unref?.()

type Row = { uuid: string; type: string; subtype?: string; timestamp: string; queued?: true; isMeta?: boolean; attachment?: { type?: string; commandMode?: string; prompt?: unknown }; message?: { content?: unknown } }
type Guts = { attached: boolean; tick: () => Promise<void>; reconcileQueuedSends: (facts: unknown) => void; reconcileSends: () => boolean; paint: () => void }

const sid = bootstrap.getSessionId()
const home = dirname(getTranscriptPathForSession(sid))
const openWindow = (): { rows: () => Row[]; guts: Guts } => {
  const connector = new DaemonSessionConnector({ sessionId: sid, home, workspaceId: '/tmp', title: 'rig', projectLabel: 'p' } as never)
  return { rows: () => connector.records() as unknown as Row[], guts: connector as unknown as Guts }
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const facts = (queue: Array<{ value: string; mode: string }>): unknown => ({ schema: 1, sessionId: sid, atMs: Date.now(), busy: queue.length > 0, runnerGeneration: 1, queue, pendingModel: null })
const read = async (guts: Guts): Promise<void> => {
  guts.attached = true
  await guts.tick.call(guts)
  guts.attached = false
}
const first = openWindow()
const write = async (rows: unknown[]): Promise<void> => {
  await recordTranscript(rows as never)
  await flushSessionStorage()
  await read(first.guts)
}
const isNotice = (row: Row): boolean => row.type === 'attachment' && row.attachment?.type === 'queued_command' && row.attachment.commandMode === 'task-notification'
const isBoundary = (row: Row): boolean => row.type === 'system' && row.subtype === 'compact_boundary'
const wordsOf = (row: Row): string => (isNotice(row) ? String(row.attachment?.prompt) : JSON.stringify(row.message?.content ?? ''))
const shape = (rows: Row[]): string => rows.map(row => (isNotice(row) ? `notice${row.queued ? '(held)' : ''}` : isBoundary(row) ? 'BOUNDARY' : `${row.type}${row.isMeta ? '(hidden)' : ''}`)).join(' ')
const standingBefore = (rows: Row[]): Row[] => {
  const at = rows.findLastIndex(isBoundary)
  return at < 0 ? [] : rows.slice(0, at).filter(isNotice)
}
const datedBefore = (rows: Row[]): Row[] => {
  const boundary = rows.findLast(isBoundary)
  return boundary === undefined ? [] : rows.filter(row => isNotice(row) && row.queued !== true && Date.parse(row.timestamp) < Date.parse(boundary.timestamp))
}
const take = async (value: string): Promise<void> => {
  first.guts.reconcileQueuedSends(facts([{ value, mode: 'task-notification' }]))
  await sleep(15)
  first.guts.reconcileQueuedSends(facts([]))
  await sleep(15)
}
const fold = async (summary: string, after: string): Promise<void> => {
  await sleep(25)
  await write([createCompactBoundaryMessage('manual', 1000), createUserMessage({ content: summary, isCompactSummary: true, isVisibleInTranscriptOnly: true })])
  await write([createUserMessage({ content: after }), createAssistantMessage({ content: `heard: ${after}` })])
  await sleep(25)
}

const WAKE = wrapInSystemReminder('Read reference-only posts with CrewBoard.')
const UNRECORDED = wrapInSystemReminder('hook lint (Stop) blocked: 3 errors')
const BETWEEN = wrapInSystemReminder('a notice delivered between the two folds')
const HELD = wrapInSystemReminder('a notice still queued when the second fold lands')

section('F1 with no fold, a notice the window took stands as before, however long the record takes to hold it')
{
  await write([createUserMessage({ content: 'wait for the crew' }), createAssistantMessage({ content: 'waiting' })])
  await take(UNRECORDED)
  const now = Date.now
  const at = now()
  try {
    Date.now = () => at + 65 * 60_000
    first.guts.reconcileSends()
    first.guts.paint()
    check('65 minutes on, with no boundary in the record, the taken notice still stands once', first.rows().filter(row => isNotice(row) && wordsOf(row) === UNRECORDED).length === 1, shape(first.rows()))
  } finally {
    Date.now = now
  }
}

section('F2 three wakes, each recorded as a hidden row, then a fold: no notice the window held stands before the boundary')
{
  for (const n of [1, 2, 3]) {
    await take(WAKE)
    await write([createUserMessage({ content: WAKE, isMeta: true }), createAssistantMessage({ content: `reply to wake ${n}` })])
  }
  const before = first.rows()
  check('before the fold the four taken notices stand, one each', before.filter(isNotice).length === 4 && before.filter(row => isNotice(row) && wordsOf(row) === WAKE).length === 3, shape(before))
  await fold('the summary of the first stretch', 'after the first fold')
  const after = first.rows()
  check('after the fold the window\'s first row is the boundary', after.length > 0 && isBoundary(after[0]!), shape(after))
  check('no notice stands before the boundary', standingBefore(after).length === 0, `${standingBefore(after).length} standing: ${shape(after)}`)
  check('the window holds no notice dated before the boundary at all', datedBefore(after).length === 0, `${datedBefore(after).length} dated before: ${shape(after)}`)
  const second = openWindow()
  await read(second.guts)
  check('the window after the fold holds the rows a second window reads from the same record, in the same order', JSON.stringify(after.map(row => row.uuid)) === JSON.stringify(second.rows().map(row => row.uuid)), `first: ${shape(after)} | second: ${shape(second.rows())}`)
  check('the rows after the boundary are the record\'s own: the summary, the prompt, the reply', shape(after) === 'BOUNDARY user user assistant', shape(after))
}

section('F3 a notice delivered after the fold stands below the boundary; the next fold takes it, and leaves a notice still queued')
{
  await take(BETWEEN)
  const standing = first.rows()
  const noticeAt = standing.findIndex(row => isNotice(row) && wordsOf(row) === BETWEEN)
  check('a notice delivered after the fold stands, below the boundary', noticeAt > standing.findLastIndex(isBoundary) && standing.filter(isNotice).length === 1, shape(standing))
  first.guts.reconcileQueuedSends(facts([{ value: HELD, mode: 'task-notification' }]))
  const held = first.rows().filter(row => isNotice(row) && wordsOf(row) === HELD)
  check('a notice still in the runner\'s queue stands held', held.length === 1 && held[0]!.queued === true, shape(first.rows()))
  await fold('the summary of the second stretch', 'after the second fold')
  first.guts.reconcileQueuedSends(facts([{ value: HELD, mode: 'task-notification' }]))
  const after = first.rows()
  check('the second fold takes the notice delivered between the folds', !after.some(row => isNotice(row) && wordsOf(row) === BETWEEN), shape(after))
  check('the notice still queued when the fold landed stands held, after the boundary', after.filter(row => isNotice(row) && wordsOf(row) === HELD && row.queued === true).length === 1 && standingBefore(after).length === 0, shape(after))
  first.guts.reconcileQueuedSends(facts([]))
  const taken = first.rows()
  const takenAt = taken.findIndex(row => isNotice(row) && wordsOf(row) === HELD)
  check('taken after the fold, it stands delivered below the boundary', takenAt > taken.findLastIndex(isBoundary) && taken[takenAt]!.queued !== true && datedBefore(taken).length === 0, shape(taken))
}

clearTimeout(watchdog)
console.log(`\n${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
