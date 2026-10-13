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

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { exitNoteDue, HANDOFF_EXIT_NOTICE } = await import('../../src/mneme/exitHandoff.ts')
const { liveWorkAtExit } = await import('../../src/commands/exit/exit.tsx')
const { ExitHandoff, HANDOFF_SKIP_GRACE_MS, leaveNoteAtExit, noteAskedAtExit } = await import('../../src/components/ExitHandoff.tsx')
const { getFocusedSessionConnector, hasFocusedSession, releaseFocusedSessionConnector, setFocusedSessionConnector, _resetFocusedSessionConnectorForTesting } = await import('../../src/services/engine-connector/focusedConnector.ts')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const { liveWorkWords } = await import('../../src/utils/task/framework.ts')
const React = await import('react')
const { Box } = await import('../../src/ink.ts')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
type Connector = import('../../src/services/engine-connector/types.ts').EngineConnectorV1
type LeaveReceipt = import('../../src/services/engine-connector/types.ts').LeaveReceiptV1
type WorkRow = import('../../src/services/engine-connector/types.ts').WorkRowV1

const row = (kind: WorkRow['kind'], status: string, id: string): WorkRow => ({ id, kind, name: id, status, startTime: 1 })
function hosted(leave: Connector['leave'], rows: WorkRow[] = []): Connector {
  const base = noSessionConnector()
  return { ...base, sessionId: () => '00000000-0000-4000-8000-0000000000aa', workRoster: () => ({ rows, mission: [], reported: true }), leave } as Connector
}

section('§1 with no session in the slot the old road stands: nothing due, the local count alone')
{
  _resetFocusedSessionConnectorForTesting()
  check('no focused session and no turn in this process: no note is asked for', hasFocusedSession() === false && exitNoteDue() === false && noteAskedAtExit() === false)
  const counts = liveWorkAtExit(undefined)
  check('the live-work count is the local count alone', j(counts) === j({ total: 0, shells: 0, agents: 0, workflows: 0, other: 0 }), j(counts))
  const receipt = await leaveNoteAtExit(new AbortController().signal)
  check('the local leave is skipped (nothing to hand off in this process)', receipt === 'skipped', receipt)
}

section('§2 a hosted session in the slot: the note is asked of the SESSION, whatever this process knows')
{
  const calls: AbortSignal[] = []
  setFocusedSessionConnector(hosted(async opts => {
    calls.push(opts!.signal!)
    return { note: 'stored' }
  }))
  check('this process still has no turn of its own, yet the exit asks', exitNoteDue() === false && noteAskedAtExit() === true)
  const receipt = await leaveNoteAtExit(new AbortController().signal)
  check("the leave rides the connector and answers with the session's word", receipt === 'stored' && calls.length === 1, `${receipt} · ${calls.length} calls`)
  check('the connector was handed the abort signal', calls[0] instanceof AbortSignal)
  releaseFocusedSessionConnector()
}

section("§3 the exit card counts the runner's own work beside the local tasks (CRW-10)")
{
  setFocusedSessionConnector(hosted(async () => ({ note: 'skipped' }), [row('agent', 'running', 'crewmate-1'), row('agent', 'completed', 'crewmate-2'), row('shell', 'running', 'sh-1'), row('workflow', 'paused', 'wf-1'), row('monitor', 'pending', 'mon-1')]))
  const counts = liveWorkAtExit(undefined)
  check('one running agent, two running shells (the monitor counts as a shell), no paused workflow, nothing finished', j(counts) === j({ total: 3, shells: 2, agents: 1, workflows: 0, other: 0 }), j(counts))
  check('the card words name them by kind', liveWorkWords(counts) === '2 shell commands and 1 crewmate', liveWorkWords(counts))
  releaseFocusedSessionConnector()
  check('with the slot released the count is local again', liveWorkAtExit(undefined).total === 0)
}

section('§4 the exit screen on the hosted road: the line while the session writes, settled by its answer')
{
  let answer: ((receipt: LeaveReceipt) => void) | null = null
  setFocusedSessionConnector(hosted(() => new Promise<LeaveReceipt>(resolve => (answer = resolve))))
  let settledWith: string | null = null
  const element = React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: 80, height: 6 }, React.createElement(ExitHandoff as never, { onSettled: (o: string) => (settledWith = o) })))
  const m = await mountOffscreen(element, 80, 6)
  const shown = await waitFor(() => m.lines().some(l => l.includes(HANDOFF_EXIT_NOTICE)), 4000)
  check('the one-line notice is on screen while the session writes', shown, m.lines().filter(l => l.trim()).join(' | '))
  await settle(120)
  check('nothing settles before the session answers', settledWith === null, String(settledWith))
  answer!({ note: 'stored' })
  const done = await waitFor(() => settledWith !== null, 4000)
  check("the session's answer settles the exit with its word", done && settledWith === 'stored', String(settledWith))
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
  let settledWith: string | null = null
  const element = React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: 80, height: 6 }, React.createElement(ExitHandoff as never, { onSettled: (o: string) => (settledWith = o) })))
  const m = await mountOffscreen(element, 80, 6)
  await waitFor(() => m.lines().some(l => l.includes(HANDOFF_EXIT_NOTICE)), 4000)
  await settle(60)
  const pressedAt = Date.now()
  m.push('\x03')
  const cut = await waitFor(() => settledWith !== null, 4000)
  check('ctrl-c aborts the leave and the exit settles without a note', cut && settledWith === 'none' && aborted === 'the handoff was skipped by ctrl-c', `${settledWith} · ${aborted}`)
  check('the skip settles at once, not after the grace', Date.now() - pressedAt < HANDOFF_SKIP_GRACE_MS, `${Date.now() - pressedAt} ms`)
  m.unmount()
  releaseFocusedSessionConnector()

  setFocusedSessionConnector(hosted(() => new Promise<LeaveReceipt>(() => {})))
  let deaf: string | null = null
  const deafElement = React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: 80, height: 6 }, React.createElement(ExitHandoff as never, { onSettled: (o: string) => (deaf = o) })))
  const d = await mountOffscreen(deafElement, 80, 6)
  await waitFor(() => d.lines().some(l => l.includes(HANDOFF_EXIT_NOTICE)), 4000)
  await settle(60)
  const t0 = Date.now()
  d.push('\x03')
  await settle(HANDOFF_SKIP_GRACE_MS / 2)
  check('a session that ignores the skip has not settled the exit before the grace', deaf === null, String(deaf))
  const left = await waitFor(() => deaf !== null, HANDOFF_SKIP_GRACE_MS + 2000)
  check('after the grace the exit leaves without a note', left && deaf === 'none' && Date.now() - t0 >= HANDOFF_SKIP_GRACE_MS, `${deaf} after ${Date.now() - t0} ms`)
  d.unmount()
  releaseFocusedSessionConnector()
  check('the slot rests again', getFocusedSessionConnector().sessionId() === '' && hasFocusedSession() === false)
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ EXIT HOSTED ROAD GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ EXIT HOSTED ROAD RED (${failures} of ${checks} checks failed)`)
process.exit(1)
