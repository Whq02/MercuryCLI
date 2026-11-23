#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { liveTurnStateOf } = await import('../../src/sessions/resume/conversationRecovery.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}${!ok ? ' | W1: change liveTurnStateOf in src/sessions/resume/conversationRecovery.ts; W2: change live() of DaemonSessionConnector in src/engine/connector/daemonConnector.ts; W3 and W4: change what the Chat hands the spinner (its mode) and the hold row (the response length ref)' : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)

type Msg = Record<string, unknown>
const at = (secondsAgo: number): string => new Date(Date.now() - secondsAgo * 1000).toISOString()
const user = (text: string, secondsAgo: number): Msg => ({
  type: 'user',
  isMeta: false,
  timestamp: at(secondsAgo),
  message: { role: 'user', content: text },
})
const assistantText = (text: string, secondsAgo: number): Msg => ({
  type: 'assistant',
  timestamp: at(secondsAgo),
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})
const assistantToolUse = (id: string, secondsAgo: number): Msg => ({
  type: 'assistant',
  timestamp: at(secondsAgo),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: {} }] },
})
const assistantThinking = (secondsAgo: number): Msg => ({
  type: 'assistant',
  timestamp: at(secondsAgo),
  message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] },
})
const toolResult = (id: string, secondsAgo: number): Msg => ({
  type: 'user',
  isMeta: false,
  timestamp: at(secondsAgo),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
})

section('W1 the fold is honest per phase')
{
  const preToken = liveTurnStateOf([user('do the thing', 5)] as never)
  check('pre-first-token: in flight', preToken.inFlight === true)
  check(
    "pre-first-token: phase is 'thinking', NEVER 'responding' (nothing has streamed)",
    preToken.phase === 'thinking',
    preToken.phase,
  )
  const toolOpen = liveTurnStateOf([
    user('do the thing', 60),
    assistantToolUse('tu_1', 50),
  ] as never)
  check("an unresolved tool ⇒ 'tool'", toolOpen.phase === 'tool' && toolOpen.inProgressToolUseIDs.has('tu_1'), toolOpen.phase)
  const thinkingTail = liveTurnStateOf([
    user('do the thing', 60),
    assistantThinking(50),
  ] as never)
  check("a thinking tail ⇒ 'thinking'", thinkingTail.phase === 'thinking', thinkingTail.phase)
  const settled = liveTurnStateOf([
    user('do the thing', 60),
    assistantToolUse('tu_1', 50),
    toolResult('tu_1', 40),
    assistantText('done.', 30),
  ] as never)
  check('a settled turn ⇒ idle', settled.inFlight === false && settled.phase === 'idle', settled.phase)
}

section('W2 the connector busy-union never claims writing for a fold-idle transcript')
{
  const scratch = mkdtempSync(join(tmpdir(), 'writing-indicator-'))
  const planeBefore = process.env.MERCURY_DAEMON_DIR
  process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
  mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
  const { DaemonSessionConnector } = await import('../../src/engine/connector/daemonConnector.ts')
  const { publishSessionFacts, publishSessionTail } = await import('../../src/engine/connector/seatProjections.ts')
  const sessionId = 'writing-indicator'
  let factsFeedReads: () => void = () => {}
  const seat = new DaemonSessionConnector({ sessionId, runnerId: 'runner-1', title: 'the chat', projectLabel: 'proof', workspaceId: scratch, home: scratch }, {
    factsRead: (read: () => void) => {
      factsFeedReads = read
    },
  })
  const reads = seat as unknown as { readTail(): void }
  let stamp = 0
  const facts = (busy: boolean): void => {
    publishSessionFacts({
      schema: 1,
      sessionId,
      atMs: ++stamp,
      pendingModel: null,
      busy,
      model: { effective: 'claude-sonnet-5-5', setting: null },
      usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false },
      identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
      skills: [],
      mcp: [],
      workspace: { cwd: scratch, originalCwd: scratch, projectRoot: scratch },
      queue: [],
    })
    factsFeedReads()
  }
  const tail = (says: Record<string, unknown>): void => {
    publishSessionTail({ schema: 1, sessionId, atMs: ++stamp, text: null, ...says } as never)
    reads.readTail()
  }
  const fold = { schema: 1, trigger: 'auto', startedAtMs: 1, stages: ['summarising', 'restoring'], stage: 'summarising', fill: 0.4, summaryTokens: 10, summaryCapTokens: 100, attempt: 1 }
  facts(true)
  check(
    "the union stamps 'thinking' when busy over an idle fold (dispatched, nothing streamed)",
    seat.live().inFlight === true && seat.live().phase === 'thinking',
    JSON.stringify(seat.live()),
  )
  tail({ stateWord: 'compacting', fold })
  const running = seat.live().phase
  tail({ stateWord: 'compacting', fold: { ...fold, exit: 'landed', endedAtMs: 2 } })
  const landed = seat.live().phase
  tail({ stateWord: 'compacting' })
  const unrecorded = seat.live().phase
  check(
    "…the compacting window keeps the fold's own word (never the thinking dress) — only while the fold's record says it still runs: the word ranks below the record's exit, so a landed fold never dresses the next turn",
    running === 'compacting' && landed === 'thinking' && unrecorded === 'compacting',
    `running ${running} · landed ${landed} · no record ${unrecorded}`,
  )
  tail({})
  const quiet = seat.live().phase
  tail({ streamBlock: 'text', blockSinceMs: 3 })
  const streaming = seat.live().phase
  check(
    "…and no code path stamps 'responding' from the busy bit",
    quiet === 'thinking' && streaming === 'responding',
    `busy with nothing streaming ${quiet} · a text block streaming ${streaming}`,
  )
  if (planeBefore === undefined) delete process.env.MERCURY_DAEMON_DIR
  else process.env.MERCURY_DAEMON_DIR = planeBefore
  rmSync(scratch, { recursive: true, force: true })
}

let heldFigure: number | undefined
section('W3 the Chat hands the spinner all three live phases')
{
  const { openStatusPart } = await import('../ui/chatScenarios.ts')
  const { IDLE_LIVE } = await import('../../src/engine/connector/seatLive.ts')
  const status = await openStatusPart('writing-indicator-status', { keepHome: true })
  const modeOf = async (phase: 'tool' | 'thinking' | 'responding'): Promise<string> => {
    await status.plant({ seatLive: { ...IDLE_LIVE, inFlight: true, phase } })
    return String(status.handed.spinner?.mode)
  }
  const toolMode = await modeOf('tool')
  const thinkingMode = await modeOf('thinking')
  const respondingMode = await modeOf('responding')
  status.session.chars = 777
  await status.plant({ textActive: true })
  heldFigure = (status.handed.hold?.responseLengthRef as { current: number } | undefined)?.current
  await status.close()
  check(
    "the 'tool' phase maps to the dedicated 'tool-use' spinner mode",
    toolMode === 'tool-use' && respondingMode === 'responding',
    `${toolMode} · ${respondingMode}`,
  )
  check(
    'the thinking arm survives beside it',
    thinkingMode === 'thinking',
    thinkingMode,
  )
}

section('W4 the streaming hold row IS the writing indicator')
{
  check(
    'the Chat feeds the hold row the live ref',
    heldFigure === 777,
    String(heldFigure),
  )
}

console.log(
  failures === 0
    ? '\n ✅ WRITING INDICATOR — thinking before the first token, tools as tools, and a count that moves while the agent writes'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
