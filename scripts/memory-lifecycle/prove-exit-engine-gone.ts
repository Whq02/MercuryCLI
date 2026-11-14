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

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const state = await import('../../src/bootstrap/state.ts')
const forked = await import('../../src/utils/forkedAgent.ts')
const { noteSessionEngine, _resetLineageSessionForTesting } = await import('../../src/mneme/lineageSession.ts')
const { ledgerEntryOf } = await import('../../src/mneme/ledger.ts')
const { mnemeProjectKey } = await import('../../src/mneme/paths.ts')
const { leaveNoteBeforeExit } = await import('../../src/mneme/exitHandoff.ts')
const { askForHandoff, _resetHandoffAskForTesting } = await import('../../src/mneme/handoffAsk.ts')
const { _resetSessionClosersForTesting } = await import('../../src/mneme/sessionClose.ts')
const ladders = await import('../../src/services/api/reconnectLadder.ts')
const { recoveryNoticeFacts } = await import('../../src/services/api/recoveryBudget.ts')
const { createSystemAPIErrorMessage } = await import('../../src/utils/messages/systemMessages.ts')
const { sleep } = await import('../../src/utils/sleep.ts')

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
const outageNotice = (ladder: import('../../src/services/api/reconnectLadder.ts').ReconnectLadder, cause: { code: string; words: string }): { notice: unknown; waitMs: number } => {
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
  check('a refused connection is an outage notice that waits 5 s before its first reconnect, inside a ten-minute budget', facts?.kind === 'outage' && facts.outage?.code === 'ECONNREFUSED' && first.waitMs === 5_000 && String((first.notice as { error: Error }).error.message).startsWith('network unreachable (connection refused) — waiting 5 s before reconnect 1; '), JSON.stringify(facts))
}

section('2 · /exit on a session whose engine is gone: the note is given up at once')
for (const code of ['ECONNREFUSED', 'ConnectionRefused']) {
  freshSession()
  const seen = { notices: [] as string[] }
  const started = Date.now()
  const outcome = await leaveNoteBeforeExit({ budgetMs: 9_000, run: roadWithNothingListening({ code, words: 'connection refused' }, seen) as never })
  const took = Date.now() - started
  check(`${code}: the leave ends inside a second with no note, where it waited out its budget on the reconnect ladder`, outcome === 'none' && took < 1_000, `${outcome} after ${took} ms · ${seen.notices.length} notice(s)`)
  check(`${code}: one connection was tried and no reconnect waited for`, seen.notices.length === 1, seen.notices.join(' | '))
  check(`${code}: the session's entry holds no note`, ledgerEntryOf(mnemeProjectKey(), String(state.getSessionId()))?.handoff === null)
}

section('3 · the note asked at the end of a last turn takes the same way out')
{
  freshSession()
  const seen = { notices: [] as string[] }
  const started = Date.now()
  const note = await askForHandoff({ cacheSafeParams: fakeParams, budgetMs: 9_000, run: roadWithNothingListening({ code: 'ECONNREFUSED', words: 'connection refused' }, seen) as never })
  const took = Date.now() - started
  check('the ask returns no note inside a second', note === null && took < 1_000, `${JSON.stringify(note)} after ${took} ms`)
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
  check('a reply that takes 1.3 s is waited for and stored', outcome === 'stored' && took >= 1_250 && ledgerEntryOf(mnemeProjectKey(), String(state.getSessionId()))?.handoff?.text === NOTE, `${outcome} after ${took} ms`)
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
  check('a host not found is waited on and the note written once it answers', outcome === 'stored' && notices >= 1, `${outcome} after ${notices} notice(s)`)
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
  check('a busy refusal is retried and the note written', busy === 'stored', busy)
  const plain = { type: 'assistant', uuid: 'a-2', timestamp: '', message: { role: 'assistant', content: [{ type: 'text', text: 'network unreachable (connection refused) — waiting 5 s before reconnect 1' }] } }
  freshSession()
  const quoted = await leaveNoteBeforeExit({
    budgetMs: 9_000,
    run: (async (params: Params) => {
      params.onMessage?.(plain)
      return { messages: [plain], terminal: { reason: 'completed' } }
    }) as never,
  })
  check('a reply that only says those words is a reply: stored', quoted === 'stored', quoted)
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\nprove-exit-engine-gone: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
