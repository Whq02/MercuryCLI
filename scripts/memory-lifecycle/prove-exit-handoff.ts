#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KEY, mountOffscreen, settle, waitFor } from '../lib/settingsPopupHarness.ts'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'exit-handoff-home-'))
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
const state = await import('../../src/bootstrap/state.ts')
const forked = await import('../../src/utils/forkedAgent.ts')
const { noteSessionEngine, closeLineageSession, _resetLineageSessionForTesting } = await import('../../src/mneme/lineageSession.ts')
const { ledgerEntryOf, readLedger } = await import('../../src/mneme/ledger.ts')
const { mnemeProjectKey } = await import('../../src/mneme/paths.ts')
const { exitNoteDue, leaveNoteBeforeExit, HANDOFF_EXIT_BUDGET_MS, HANDOFF_EXIT_NOTICE } = await import('../../src/mneme/exitHandoff.ts')
const { HANDOFF_ASK, _resetHandoffAskForTesting } = await import('../../src/mneme/handoffAsk.ts')
const { _resetSessionClosersForTesting } = await import('../../src/mneme/sessionClose.ts')

const key = mnemeProjectKey()
const fakeParams = { systemPrompt: ['system'] as never, userContext: {}, systemContext: {}, toolUseContext: {} as never, forkContextMessages: [] }
const reply = (text: string) => ({ type: 'assistant', uuid: 'a-1', timestamp: '', message: { role: 'assistant', content: [{ type: 'text', text }] } }) as never

function freshSession(id: string): void {
  _resetHandoffAskForTesting()
  _resetSessionClosersForTesting()
  _resetLineageSessionForTesting()
  state.switchSession(id as never)
  forked.saveCacheSafeParams(null)
}

section('§1 /exit with nothing staged: one ask, the reply stored in the entry; without a turn nothing is asked')
{
  freshSession('00000000-0000-4000-8000-00000000e001')
  check('no entry open yet: no note is due', exitNoteDue() === false)
  noteSessionEngine('claude-fable-5-1')
  check('an entry is open but no turn ran: still not due (nothing to hand off)', exitNoteDue() === false)
  forked.saveCacheSafeParams(fakeParams)
  check('after a turn, with nothing staged: due', exitNoteDue() === true)
  let calls = 0
  let askedWith = ''
  const run = async (params: { promptMessages: Array<{ message: { content: unknown } }> }) => {
    calls++
    askedWith = j(params.promptMessages[0]?.message.content)
    return { messages: [reply('The work: the exit road.\nStill to do: nothing.')], terminal: { reason: 'completed' } }
  }
  const outcome = await leaveNoteBeforeExit({ run: run as never })
  check('the ask ran once and the note was stored', outcome === 'stored' && calls === 1, `${outcome} calls=${calls}`)
  check('the ask carried the record law', askedWith.includes(HANDOFF_ASK.slice(0, 40)), askedWith.slice(0, 120))
  const entry = ledgerEntryOf(key, String(state.getSessionId()))
  check('the entry holds the reply verbatim, stamped', entry?.handoff?.text === 'The work: the exit road.\nStill to do: nothing.' && typeof entry?.handoff?.at === 'string', j(entry?.handoff))
  check('the exit budget is in the ruled range (15–30 s)', HANDOFF_EXIT_BUDGET_MS >= 15_000 && HANDOFF_EXIT_BUDGET_MS <= 30_000, String(HANDOFF_EXIT_BUDGET_MS))
}

section('§2 /exit with a note already staged: no model call')
{
  check('a staged note means nothing is due', exitNoteDue() === false)
  let calls = 0
  const outcome = await leaveNoteBeforeExit({
    run: (async () => {
      calls++
      return { messages: [reply('never')] }
    }) as never,
  })
  check('skipped without a call; the stored note stands', outcome === 'skipped' && calls === 0 && ledgerEntryOf(key, String(state.getSessionId()))?.handoff?.text.startsWith('The work: the exit road.') === true, `${outcome} calls=${calls}`)
}

section('§3 the bound fires: the session closes with no note rather than hanging')
{
  freshSession('00000000-0000-4000-8000-00000000e002')
  noteSessionEngine('claude-fable-5-1')
  forked.saveCacheSafeParams(fakeParams)
  const started = Date.now()
  const outcome = await leaveNoteBeforeExit({
    budgetMs: 80,
    run: (params: { overrides?: { abortController?: AbortController } }) =>
      new Promise((_, reject) => {
        params.overrides?.abortController?.signal.addEventListener('abort', () => reject(new Error('cut')), { once: true })
      }),
  })
  const took = Date.now() - started
  check('the ask was cut at the bound and reported no note', outcome === 'none' && took < 2000, `${outcome} after ${took}ms`)
  const ctx = await closeLineageSession('quit', 200)
  const entry = ledgerEntryOf(key, String(state.getSessionId()))
  check('the entry closed with handoff null and the closers saw no note', entry?.endedAt !== null && entry?.handoff === null && ctx?.handoff === null && ctx?.outcome === 'quit', j(entry))
  check('the ledger still holds both sessions in order', readLedger(key).map(e => e.ordinal).join(',') === '1,2')
}

section('§4 the notice while it waits, and ctrl-c skips it')
{
  const React = await import('react')
  const { Box } = await import('../../src/ink.js')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
  const { ExitHandoff } = await import('../../src/components/ExitHandoff.js')
  freshSession('00000000-0000-4000-8000-00000000e003')
  noteSessionEngine('claude-fable-5-1')
  forked.saveCacheSafeParams(fakeParams)
  check('a third session with a turn and nothing staged is due', exitNoteDue() === true)
  let settledWith: string | null = null
  const element = React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: 80, height: 6 }, React.createElement(ExitHandoff as never, { onSettled: (o: string) => (settledWith = o) })))
  const m = await mountOffscreen(element, 80, 6)
  const shown = await waitFor(() => m.lines().some(l => l.includes(HANDOFF_EXIT_NOTICE)), 4000)
  check('the one-line notice is on screen while the ask runs', shown, m.lines().filter(l => l.trim()).join(' | '))
  await settle(60)
  m.push('\x03')
  const cut = await waitFor(() => settledWith !== null, 4000)
  check('ctrl-c settles the exit without a note', cut && settledWith === 'none', String(settledWith))
  m.unmount()
  const entry = ledgerEntryOf(key, String(state.getSessionId()))
  check('nothing was stored for the skipped ask', entry?.handoff === null, j(entry?.handoff))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ EXIT HANDOFF GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ EXIT HANDOFF RED (${failures} of ${checks} checks failed)`)
process.exit(1)
