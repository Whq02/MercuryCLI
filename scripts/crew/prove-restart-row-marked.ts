#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'restart-row-marked-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${t}`)

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const lr = await import('../../src/engine/tasks/local-agent/launchReceipts.ts')
const { carryRunnerAcrossRestart } = await import('../../src/daemon/runner/restartCarry.ts')
const queue = await import('../../src/screen/composer/input-core/command-queue.ts')
const { noticeOfText, wrappedNoticeBlocks } = await import('../../src/engine/message-shapes/noticeRows.ts')
const { selectableUserMessagesFilter } = await import('../../src/screen/rewind-picker/RewindPicker.tsx')
const { getFirstMeaningfulUserMessageTextContent } = await import('../../src/sessions/transcripts/chain.ts')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
type Message = import('../../src/engine/message-shapes/message.ts').Message
type AppState = import('../../src/screen/app-state/AppStateStore.ts').AppState

let n = 0
const stamp = (): string => new Date(1_700_000_000_000 + ++n * 1000).toISOString()
const launch: Message = {
  type: 'assistant',
  uuid: `a-${++n}`,
  timestamp: stamp(),
  requestId: undefined,
  message: {
    id: 'msg_launch',
    model: 'claude-fable-5-1',
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_sleep', name: 'Crewmate', input: { description: 'Run sleep command', prompt: 'sleep 300', crewmate_type: 'mercury-crew', run_in_background: true } }],
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    stop_reason: 'tool_use',
  },
} as unknown as Message
const receipt: Message = {
  type: 'user',
  uuid: `u-${++n}`,
  timestamp: stamp(),
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_sleep', content: [{ type: 'text', text: `${lr.BACKGROUND_LAUNCH_LINE}\nagentId: agent-sleep (internal — do not mention it to the user). To continue this crewmate, use SendMessage addressed to that id.\nThe crewmate is working in the background — you will be notified automatically when it completes.` }] }],
  },
} as unknown as Message
const userRow = (text: string): Message => ({ type: 'user', uuid: `u-${++n}`, timestamp: stamp(), message: { role: 'user', content: text } }) as unknown as Message

let state: AppState = { ...getDefaultAppState(), tasks: {} } as AppState
const transcriptPath = join(scratch, 'session.jsonl')
writeFileSync(transcriptPath, '')
const outcome = await carryRunnerAcrossRestart({
  reason: 'crash',
  messages: [launch, receipt],
  getAppState: () => state,
  setAppState: update => { state = typeof update === 'function' ? (update as (prev: AppState) => AppState)(state) : update },
  canUseTool: (async () => ({ behavior: 'deny', message: 'no tools in this proof' })) as never,
  relaunchContext: async () => { throw new Error('no relaunch in this proof') },
  transcriptPath,
  now: 1_700_000_100_000,
})

section("§1 the restart row the carry queues (RELEASE-29-AIR R29A-05c: it painted as '[whq] ❯ runner restarted after a crash: …' and became the session's last prompt)")
const queued = queue.getCommandQueue().filter(command => command.mode === 'task-notification')
const text = queued.map(command => (typeof command.value === 'string' ? command.value : '')).find(value => lr.isRestartCarryRow(value)) ?? ''
check('the carry queued one restart row for the orphaned launch', outcome.row !== null && outcome.stopped === 1 && text !== '', `${JSON.stringify({ outcome, queued: queued.map(c => c.value) })} — carryRunnerAcrossRestart in src/daemon/runner/restartCarry.ts must enqueue the restart row as a task-notification and count the orphaned launch as stopped`)
check('the words are the ruled words, unchanged', outcome.row === 'runner restarted after a crash: 0 background crewmates relaunched, 0 delivered from their receipts, 1 stopped' && text.includes(outcome.row ?? '!'), `${text} — restartCarryRow in src/engine/tasks/local-agent/launchReceipts.ts builds these words; restore them there`)
check('the row carries the system marker the siblings carry (a hook block, a monitor notice): a system-reminder envelope', text.startsWith('<system-reminder>\n') && text.endsWith('\n</system-reminder>'), `${text} — carryRunnerAcrossRestart in src/daemon/runner/restartCarry.ts must enqueue the row through wrapInSystemReminder`)
const folded = noticeOfText(text, false)
check('the message the idle turn builds from it folds as a notice OFF the notification lane (the painter draws no operator plate)', folded !== null && folded[0]!.kind === 'notice' && folded[0]!.lines[0] === outcome.row, `${JSON.stringify(folded)} — noticeOfText in src/engine/message-shapes/noticeRows.ts must fold a system-reminder wrapped row into one notice block whose first line is the row`)
check('…and wrappedNoticeBlocks knows it (the prompt list reads the same predicate)', wrappedNoticeBlocks(text) !== null, 'wrappedNoticeBlocks in src/engine/message-shapes/noticeRows.ts must recognise the wrapped restart row')
check("it is never selectable as one of the operator's prompts", !selectableUserMessagesFilter(userRow(text)), 'selectableUserMessagesFilter in src/screen/rewind-picker/RewindPicker.tsx must reject a user row whose text is the wrapped restart row')
check("it is never the session's last prompt", getFirstMeaningfulUserMessageTextContent([userRow(text)]) === undefined, 'getFirstMeaningfulUserMessageTextContent in src/sessions/transcripts/chain.ts must skip the wrapped restart row; see SKIP_FIRST_PROMPT_PATTERN there')
check('it still wakes an idle runner: the held-notice wake reads the wrapped row', queued.some(command => queue.isHeldNotice(command)) && queue.isRestartCarryText(text) && lr.isRestartCarryRow(text), 'isHeldNotice and isRestartCarryText in src/screen/composer/input-core/command-queue.ts must still match the wrapped row (the RESTART_CARRY_TEXT pattern)')

section('§2 guards: the bare words stay recognisable, and typed words stay the operator\'s')
const bare = lr.restartCarryRow('stop', { relaunched: 1, delivered: 0, stopped: 0 })
check('the bare row (an older runner\'s queue log) is still recognised by the wake', lr.isRestartCarryRow(bare) && queue.isRestartCarryText(bare) && !lr.isRestartCarryRow('<task-notification>'), 'isRestartCarryText in src/screen/composer/input-core/command-queue.ts (the RESTART_CARRY_TEXT pattern) must match the unwrapped row and nothing else')
check("the same words typed by the operator are the operator's own: no notice, selectable, the last prompt", noticeOfText(bare, false) === null && selectableUserMessagesFilter(userRow(bare)) && getFirstMeaningfulUserMessageTextContent([userRow(bare)]) === bare, 'only the system-reminder wrapped row is a notice: noticeOfText (src/engine/message-shapes/noticeRows.ts) must leave the bare words as the operator\'s prompt')
check("an operator's prose that mentions a restart is not a restart row", !lr.isRestartCarryRow('the runner restarted again, why?'), 'RESTART_CARRY_TEXT in src/screen/composer/input-core/command-queue.ts must match only text that begins with the row prefix')


console.log(failures === 0 ? '\nprove-restart-row-marked: all green' : `\nprove-restart-row-marked: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
