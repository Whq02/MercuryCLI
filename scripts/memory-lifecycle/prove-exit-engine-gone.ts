#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withProofAccountHome } from '../lib/proofAccountHome.ts'

withProofAccountHome('exit-engine-gone-')
process.env.NODE_ENV = 'test'
const HOME = mkdtempSync(join(tmpdir(), 'exit-engine-gone-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE
delete process.env.MERCURY_RECONNECT_SCALE
delete process.env.MERCURY_RECONNECT_BUDGET_MINUTES

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const state = await import('../../src/boot/process-state/processState.ts')
const forked = await import('../../src/crew/agents/forkedAgent.ts')
const { noteSessionEngine, _resetLineageSessionForTesting } = await import('../../src/sessions/mneme/lineageSession.ts')
const { ledgerEntryOf } = await import('../../src/sessions/mneme/ledger.ts')
const { mnemeProjectKey } = await import('../../src/sessions/mneme/paths.ts')
const { leaveNoteBeforeExit } = await import('../../src/sessions/mneme/exitHandoff.ts')
const { askForHandoff, _resetHandoffAskForTesting } = await import('../../src/sessions/mneme/handoffAsk.ts')
const { _resetSessionClosersForTesting } = await import('../../src/sessions/mneme/sessionClose.ts')
const ladders = await import('../../src/engine/requests/reconnectLadder.ts')
const { recoveryNoticeFacts } = await import('../../src/engine/requests/recoveryBudget.ts')
const { createSystemAPIErrorMessage } = await import('../../src/engine/message-shapes/systemMessages.ts')
const { sleep } = await import('../../src/platform/async/sleep.ts')

type Params = { onMessage?: (message: unknown) => void; overrides?: { abortController?: AbortController } }
type Answer = { messages: unknown[]; terminal: { reason: string } }
const fakeParams = { systemPrompt: ['system'] as never, userContext: {}, systemContext: {}, toolUseContext: {} as never, forkContextMessages: [] }
const NOTE = 'The work: the exit road.\nStill to do: nothing.'
const reply = (text: string): unknown => ({ type: 'assistant', uuid: 'a-1', timestamp: '', message: { role: 'assistant', content: [{ type: 'text', text }] } })
let ordinal = 0
function freshSession(): void {
  _resetHandoffAskForTesting()
  _resetSessionClosersForTesting()
  _resetLineageSessionForTesting()
  state.switchSession(`00000000-0000-4000-8000-0000000e9${String(++ordinal).padStart(3, '0')}` as never)
  noteSessionEngine('local/qwen3.5-2b')
  forked.saveCacheSafeParams(fakeParams)
}
const outageNotice = (ladder: import('../../src/engine/requests/reconnectLadder.ts').ReconnectLadder, cause: { code: string; words: string }): { notice: unknown; waitMs: number } => {
  const step = ladders.nextReconnect(ladder, cause, Date.now())
  return { notice: createSystemAPIErrorMessage(new ladders.NetworkOutageError(step, Object.assign(new Error(`${cause.code} connect 127.0.0.1 8080`), { code: cause.code })), step.waitMs, step.reconnect, step.of), waitMs: step.waitMs }
}

function roadWithNothingListening(cause: { code: string; words: string }, seen: { notices: string[] }): (params: Params) => Promise<Answer> {
  return async params => {
    const signal = params.overrides!.abortController!.signal
    const ladder = ladders.openReconnectLadder(Date.now(), cause)
    const messages: unknown[] = []
    for (;;) {
      const { notice, waitMs } = outageNotice(ladder, cause)
      messages.push(notice)
      seen.notices.push(String((notice as { error: Error }).error.message))
      params.onMessage?.(notice)
      await sleep(waitMs, signal)
      if (signal.aborted) return { messages, terminal: { reason: 'aborted_streaming' } }
    }
  }
}

section('1 · the road as it answers when nothing listens: a refused connection, then the reconnect ladder')
{
  const cause = { code: 'ECONNREFUSED', words: 'connection refused' }
  const first = outageNotice(ladders.openReconnectLadder(Date.now(), cause), cause)
  const facts = recoveryNoticeFacts(first.notice)
  check('a refused connection is an outage notice that waits 5 s before its first reconnect, inside a ten-minute budget', facts?.kind === 'outage' && facts.outage?.code === 'ECONNREFUSED' && first.waitMs === 5_000 && String((first.notice as { error: Error }).error.message).startsWith('network unreachable (connection refused) — waiting 5 s before reconnect 1; '), JSON.stringify(facts) + ' · look at nextReconnect in src/engine/requests/reconnectLadder.ts (first wait, OUTAGE_WORDS codes) and recoveryNoticeFacts in src/engine/requests/recoveryBudget.ts')
}

section('2 · /exit on a session whose engine is gone: the note is given up at once')
for (const code of ['ECONNREFUSED', 'ConnectionRefused']) {
  freshSession()
  const seen = { notices: [] as string[] }
  const started = Date.now()
  const outcome = await leaveNoteBeforeExit({ budgetMs: 9_000, run: roadWithNothingListening({ code, words: 'connection refused' }, seen) as never })
  const took = Date.now() - started
  check(`${code}: the leave ends inside a second with no note, where it waited out its budget on the reconnect ladder`, outcome === 'none' && took < 1_000, `${outcome} after ${took} ms · ${seen.notices.length} notice(s) · a refused connection must abort the ask: see the onMessage hook and outageIsRefusal in src/sessions/mneme/handoffAsk.ts`)
  check(`${code}: one connection was tried and no reconnect waited for`, seen.notices.length === 1, seen.notices.join(' | ') + ' · the ask must abort on the first refusal notice: see onMessage in askForHandoff, src/sessions/mneme/handoffAsk.ts')
  check(`${code}: the session's entry holds no note`, ledgerEntryOf(mnemeProjectKey(), String(state.getSessionId()))?.handoff === null, 'leaveNoteBeforeExit in src/sessions/mneme/exitHandoff.ts must return none and store nothing when the ask gives no note')
}

section('3 · the note asked at the end of a last turn takes the same way out')
{
  freshSession()
  const seen = { notices: [] as string[] }
  const started = Date.now()
  const note = await askForHandoff({ cacheSafeParams: fakeParams, budgetMs: 9_000, run: roadWithNothingListening({ code: 'ECONNREFUSED', words: 'connection refused' }, seen) as never })
  const took = Date.now() - started
  check('the ask returns no note inside a second', note === null && took < 1_000, `${JSON.stringify(note)} after ${took} ms · askForHandoff in src/sessions/mneme/handoffAsk.ts must abort on a refused connection (outageIsRefusal)`)
}

section('4 · an engine that is there and slow keeps the whole of its time')
{
  freshSession()
  const started = Date.now()
  const outcome = await leaveNoteBeforeExit({
    budgetMs: 9_000,
    run: (async (params: Params) => {
      await sleep(1_300, params.overrides!.abortController!.signal)
      return { messages: [reply(NOTE)], terminal: { reason: 'completed' } }
    }) as never,
  })
  const took = Date.now() - started
  check('a reply that takes 1.3 s is waited for and stored', outcome === 'stored' && took >= 1_250 && ledgerEntryOf(mnemeProjectKey(), String(state.getSessionId()))?.handoff?.text === NOTE, `${outcome} after ${took} ms · a slow reply that is not a refusal must be waited for: see askForHandoff in src/sessions/mneme/handoffAsk.ts and leaveNoteBeforeExit in src/sessions/mneme/exitHandoff.ts`)
}

section('5 · a network that may come back keeps its reconnects; a busy provider keeps its retries')
{
  freshSession()
  let notices = 0
  const outcome = await leaveNoteBeforeExit({
    budgetMs: 9_000,
    run: (async (params: Params) => {
      const signal = params.overrides!.abortController!.signal
      const cause = { code: 'ENOTFOUND', words: 'host not found' }
      const { notice } = outageNotice(ladders.openReconnectLadder(Date.now(), cause), cause)
      notices++
      params.onMessage?.(notice)
      await sleep(400, signal)
      if (signal.aborted) return { messages: [notice], terminal: { reason: 'aborted_streaming' } }
      return { messages: [notice, reply(NOTE)], terminal: { reason: 'completed' } }
    }) as never,
  })
  check('a host not found is waited on and the note written once it answers', outcome === 'stored' && notices >= 1, `${outcome} after ${notices} notice(s) · only a refusal (outageIsRefusal in src/engine/requests/reconnectLadder.ts) may abort the ask in src/sessions/mneme/handoffAsk.ts`)
  freshSession()
  const busy = await leaveNoteBeforeExit({
    budgetMs: 9_000,
    run: (async (params: Params) => {
      const signal = params.overrides!.abortController!.signal
      const notice = createSystemAPIErrorMessage(Object.assign(new Error('the server is busy'), { status: 503 }) as never, 300, 1, 5)
      params.onMessage?.(notice)
      await sleep(300, signal)
      if (signal.aborted) return { messages: [notice], terminal: { reason: 'aborted_streaming' } }
      return { messages: [notice, reply(NOTE)], terminal: { reason: 'completed' } }
    }) as never,
  })
  check('a busy refusal is retried and the note written', busy === 'stored', busy + ' · a busy provider notice must not abort the ask: see onMessage in src/sessions/mneme/handoffAsk.ts')
  const plain = { type: 'assistant', uuid: 'a-2', timestamp: '', message: { role: 'assistant', content: [{ type: 'text', text: 'network unreachable (connection refused) — waiting 5 s before reconnect 1' }] } }
  freshSession()
  const quoted = await leaveNoteBeforeExit({
    budgetMs: 9_000,
    run: (async (params: Params) => {
      params.onMessage?.(plain)
      return { messages: [plain], terminal: { reason: 'completed' } }
    }) as never,
  })
  check('a reply that only says those words is a reply: stored', quoted === 'stored', quoted + ' · onMessage in src/sessions/mneme/handoffAsk.ts must judge by recoveryNoticeFacts of the message, not by its words')
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\nprove-exit-engine-gone: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
