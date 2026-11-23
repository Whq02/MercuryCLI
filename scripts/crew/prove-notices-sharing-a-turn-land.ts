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
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { DaemonSessionConnector } = await import('../../src/engine/connector/daemonConnector.ts')
const notices = await import('../../src/engine/connector/queuedNotices.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/engine/message-shapes/factories.ts')
const { recordTranscript, flushSessionStorage } = await import('../../src/sessions/transcripts/sessionStorage.ts')
const { getTranscriptPathForSession } = await import('../../src/sessions/transcripts/paths.ts')
const { wrapInSystemReminder } = await import('../../src/engine/message-shapes/text.ts')

const tally = makeTally('notices-sharing-a-turn-land')
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the shared turn proof exceeded 180s; it was waiting on a step of the section named above the last line printed, so look at the check after that line in scripts/crew/prove-notices-sharing-a-turn-land.ts')
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
const fix = 'change noticeRowLanded in src/engine/connector/queuedNotices.ts'

tally.section('§1 the landing test: a notice lands on the row that holds it as one of its text blocks')
{
  const at = Date.now()
  const stamp = (offsetMs: number): string => new Date(at + offsetMs).toISOString()
  const row = (content: unknown, extra: Record<string, unknown> = {}): Message => ({ type: 'user', uuid: 'row', timestamp: stamp(200), message: { role: 'user', content }, ...extra }) as unknown as Message
  const shared = row(blocks(ALPHA, BRAVO))
  tally.check('two monitor lines taken into one turn are one row of two text blocks: the first lands on it (the parent compares the row\'s whole text and lands neither)', notices.noticeRowLanded(shared, ALPHA, at), `${j(shared)} — ${fix} so a notice lands on a row that holds it as one of its text blocks`)
  tally.check('…and so does the second', notices.noticeRowLanded(shared, BRAVO, at), `${fix} so each notice in a multi-block row lands, not only the first`)
  tally.check('a hook\'s notice beside a monitor line lands the same way', notices.noticeRowLanded(row(blocks(ALPHA, HOOK)), HOOK, at) && notices.noticeRowLanded(row(blocks(HOOK, ALPHA)), ALPHA, at), `${fix} so a hook notice lands in a block beside a monitor line, in either order`)
  tally.check('a notice that is not one of the row\'s blocks never lands on it', !notices.noticeRowLanded(shared, ABSENT, at) && !notices.noticeRowLanded(shared, HOOK, at), `${fix} so a notice that is not one of the row's blocks does not land`)
  tally.check('a block that only quotes the notice inside other words does not land it', !notices.noticeRowLanded(row(blocks(`the watch said ${ALPHA} a moment ago`, BRAVO)), ALPHA, at), `${fix} so a block that only quotes the notice inside other words does not land it`)
  tally.check('a row older than the notice never lands it, shared or not', !notices.noticeRowLanded(row(blocks(ALPHA, BRAVO), { timestamp: stamp(-5000) }), ALPHA, at), `${fix} so a row older than the notice (the notBeforeMs test) never lands it`)
  tally.check('a hidden row never lands it', !notices.noticeRowLanded(row(blocks(ALPHA, BRAVO), { isMeta: true }), ALPHA, at), `${fix} so a hidden (isMeta) row never lands a notice`)
  tally.check('alone in its row a notice lands as it did, as the row\'s text or as its one block', notices.noticeRowLanded(row(ALPHA), ALPHA, at) && notices.noticeRowLanded(row(blocks(ALPHA)), ALPHA, at) && !notices.noticeRowLanded(row(ALPHA), BRAVO, at), `${fix} so a notice alone in its row lands as the row's text or as its one block, and only its own`)
  tally.check('a notice with a task id lands beside others as it did, by its id and its words', notices.noticeRowLanded(row(blocks(ALPHA, TASK)), TASK, at) && !notices.noticeRowLanded(row(blocks(ALPHA, TASK.replace('t-done', 't-other'))), TASK, at), `${fix} so a notice with a task id lands by its id and its words, and not on another task's id`)
}

tally.section('§2 the window: notices taken into one turn leave no row of the window\'s own beside the record\'s')

clearTimeout(watchdog)
tally.finish()
