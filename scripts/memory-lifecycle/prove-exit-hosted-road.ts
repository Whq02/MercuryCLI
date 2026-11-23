#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountOffscreen, settle, waitFor } from '../lib/settingsPopupHarness.ts'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'exit-hosted-road-home-'))
process.env.MERCURY_DAEMON_DIR = join(process.env.MERCURY_CONFIG_DIR, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.FORCE_COLOR = '3'
process.env.MERCURY_LIVE_CLOCK = '0'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)
const HOSTED_EXIT_NOTE = 'see noteAskedAtExit and leaveNoteAtExit in src/commands/exit/ExitHandoff.tsx'
const HOSTED_EXIT_SCREEN = 'see ExitHandoff in src/commands/exit/ExitHandoff.tsx'
const HOSTED_EXIT_COUNT = 'see liveWorkAtExit in src/commands/exit/exit.tsx'

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { exitNoteDue, HANDOFF_EXIT_NOTICE } = await import('../../src/sessions/mneme/exitHandoff.ts')
const { liveWorkAtExit } = await import('../../src/commands/exit/exit.tsx')
const { ExitHandoff, HANDOFF_SKIP_GRACE_MS, leaveNoteAtExit, noteAskedAtExit } = await import('../../src/commands/exit/ExitHandoff.tsx')
const { getFocusedSessionConnector, hasFocusedSession, releaseFocusedSessionConnector, setFocusedSessionConnector, _resetFocusedSessionConnectorForTesting } = await import('../../src/engine/connector/focusedConnector.ts')
const { noSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
const { liveWorkWords } = await import('../../src/engine/task-framework/taskRegistry.ts')
const React = await import('react')
const { Box } = await import('../../src/screen/themedRenderer.ts')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
type Connector = import('../../src/engine/connector/types.ts').EngineConnectorV1
type LeaveReceipt = import('../../src/engine/connector/types.ts').LeaveReceiptV1
type WorkRow = import('../../src/engine/connector/types.ts').WorkRowV1

const row = (kind: WorkRow['kind'], status: string, id: string): WorkRow => ({ id, kind, name: id, status, startTime: 1 })
function hosted(leave: Connector['leave'], rows: WorkRow[] = []): Connector {
  const base = noSessionConnector()
  return { ...base, sessionId: () => '00000000-0000-4000-8000-0000000000aa', workRoster: () => ({ rows, mission: [], reported: true }), leave } as Connector
}

section('§1 with no session in the slot the old road stands: nothing due, the local count alone')
{
  _resetFocusedSessionConnectorForTesting()
  check('no focused session and no turn in this process: no note is asked for', hasFocusedSession() === false && exitNoteDue() === false && noteAskedAtExit() === false, `${HOSTED_EXIT_NOTE} and exitNoteDue in src/sessions/mneme/exitHandoff.ts`)
  const counts = liveWorkAtExit(undefined)
  check('the live-work count is the local count alone', j(counts) === j({ total: 0, shells: 0, agents: 0, other: 0 }), `${j(counts)}; ${HOSTED_EXIT_COUNT}`)
  const receipt = await leaveNoteAtExit(new AbortController().signal)
  check('the local leave is skipped (nothing to hand off in this process)', receipt.note === 'skipped' && receipt.noteChars === undefined, `${JSON.stringify(receipt)}; ${HOSTED_EXIT_NOTE}`)
}

section('§2 a hosted session in the slot: the note is asked of the SESSION, whatever this process knows')
{
  const calls: AbortSignal[] = []
  setFocusedSessionConnector(hosted(async opts => {
    calls.push(opts!.signal!)
    return { note: 'stored' }
  }))
  check('this process still has no turn of its own, yet the exit asks', exitNoteDue() === false && noteAskedAtExit() === true, `noteAskedAtExit must be true when hasFocusedSession is true; ${HOSTED_EXIT_NOTE}`)
  const receipt = await leaveNoteAtExit(new AbortController().signal)
  check("the leave rides the connector and answers with the session's word", receipt.note === 'stored' && calls.length === 1, `${JSON.stringify(receipt)} · ${calls.length} calls; ${HOSTED_EXIT_NOTE}`)
  check('the connector was handed the abort signal', calls[0] instanceof AbortSignal, `leaveNoteAtExit must pass { signal } to the connector leave; ${HOSTED_EXIT_NOTE}`)
  releaseFocusedSessionConnector()
}

section("§3 the exit card counts the runner's own work beside the local tasks (CRW-10)")
{
  setFocusedSessionConnector(hosted(async () => ({ note: 'skipped' }), [row('agent', 'running', 'crewmate-1'), row('agent', 'completed', 'crewmate-2'), row('shell', 'running', 'sh-1'), row('workflow', 'paused', 'wf-1'), row('monitor', 'pending', 'mon-1')]))
  const counts = liveWorkAtExit(undefined)
  check('one running agent, two running shells (the monitor counts as a shell), no run row of an older runner, nothing finished', j(counts) === j({ total: 3, shells: 2, agents: 1, other: 0 }), `${j(counts)}; ${HOSTED_EXIT_COUNT}`)
  check('the card words name them by kind', liveWorkWords(counts) === '2 shell commands and 1 crewmate', `${liveWorkWords(counts)}; see liveWorkWords in src/engine/task-framework/taskRegistry.ts`)
  releaseFocusedSessionConnector()
  check('with the slot released the count is local again', liveWorkAtExit(undefined).total === 0, `${HOSTED_EXIT_COUNT}; the hosted rows count only while hasFocusedSession is true`)
}

section('§4 the exit screen on the hosted road: the line while the session writes, settled by its answer')
{
  let answer: ((receipt: LeaveReceipt) => void) | null = null
  setFocusedSessionConnector(hosted(() => new Promise<LeaveReceipt>(resolve => (answer = resolve))))
  let settledWith: { note: string } | null = null
  const element = React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: 80, height: 6 }, React.createElement(ExitHandoff as never, { onSettled: (o: { note: string }) => (settledWith = o) })))
  const m = await mountOffscreen(element, 80, 6)
  const shown = await waitFor(() => m.lines().some(l => l.includes(HANDOFF_EXIT_NOTICE)), 4000)
  check('the one-line notice is on screen while the session writes', shown, m.lines().filter(l => l.trim()).join(' | ') + `; ${HOSTED_EXIT_SCREEN} (it must render HANDOFF_EXIT_NOTICE while leave is pending)`)
  await settle(120)
  check('nothing settles before the session answers', settledWith === null, `${String(settledWith)}; ${HOSTED_EXIT_SCREEN} (onSettled must wait for the connector leave)`)
  answer!({ note: 'stored' })
  const done = await waitFor(() => settledWith !== null, 4000)
  check("the session's answer settles the exit with its word", done && settledWith?.note === 'stored', `${JSON.stringify(settledWith)}; ${HOSTED_EXIT_SCREEN} (settle with the leave receipt)`)
  m.unmount()
  releaseFocusedSessionConnector()
}

section('§5 ctrl-c skips: the signal reaches the session, and a session that never answers is left after the grace')
{
  let aborted: string | null = null
  setFocusedSessionConnector(hosted(opts => new Promise<LeaveReceipt>(resolve => {
    opts!.signal!.addEventListener('abort', () => {
      aborted = String((opts!.signal!.reason as Error).message)
      resolve({ note: 'none' })
    }, { once: true })
  })))
  let settledWith: { note: string } | null = null
  const element = React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: 80, height: 6 }, React.createElement(ExitHandoff as never, { onSettled: (o: { note: string }) => (settledWith = o) })))
  const m = await mountOffscreen(element, 80, 6)
  await waitFor(() => m.lines().some(l => l.includes(HANDOFF_EXIT_NOTICE)), 4000)
  await settle(60)
  const pressedAt = Date.now()
  m.push('\x03')
  const cut = await waitFor(() => settledWith !== null, 4000)
  check('ctrl-c aborts the leave and the exit settles without a note', cut && settledWith?.note === 'none' && aborted === 'the handoff was skipped by ctrl-c', `${JSON.stringify(settledWith)} · ${aborted}; ${HOSTED_EXIT_SCREEN} (the ctrl-c handler in useInput aborts the controller)`)
  check('the skip settles at once, not after the grace', Date.now() - pressedAt < HANDOFF_SKIP_GRACE_MS, `${Date.now() - pressedAt} ms; ${HOSTED_EXIT_SCREEN} (a leave that answers the abort must settle at once)`)
  m.unmount()
  releaseFocusedSessionConnector()

  setFocusedSessionConnector(hosted(() => new Promise<LeaveReceipt>(() => {})))
  let deaf: { note: string } | null = null
  const deafElement = React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: 80, height: 6 }, React.createElement(ExitHandoff as never, { onSettled: (o: { note: string }) => (deaf = o) })))
  const d = await mountOffscreen(deafElement, 80, 6)
  await waitFor(() => d.lines().some(l => l.includes(HANDOFF_EXIT_NOTICE)), 4000)
  await settle(60)
  const t0 = Date.now()
  d.push('\x03')
  await settle(HANDOFF_SKIP_GRACE_MS / 2)
  check('a session that ignores the skip has not settled the exit before the grace', deaf === null, `${String(deaf)}; ${HOSTED_EXIT_SCREEN} (settle only after HANDOFF_SKIP_GRACE_MS)`)
  const left = await waitFor(() => deaf !== null, HANDOFF_SKIP_GRACE_MS + 2000)
  check('after the grace the exit leaves without a note', left && deaf?.note === 'none' && Date.now() - t0 >= HANDOFF_SKIP_GRACE_MS, `${JSON.stringify(deaf)} after ${Date.now() - t0} ms; ${HOSTED_EXIT_SCREEN} (ctrl-c starts the HANDOFF_SKIP_GRACE_MS timer that settles with note none)`)
  d.unmount()
  releaseFocusedSessionConnector()
  check('the slot rests again', getFocusedSessionConnector().sessionId() === '' && hasFocusedSession() === false, 'releaseFocusedSessionConnector in src/engine/connector/focusedConnector.ts must restore the no-session connector')
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ EXIT HOSTED ROAD GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ EXIT HOSTED ROAD RED (${failures} of ${checks} checks failed)`)
process.exit(1)
