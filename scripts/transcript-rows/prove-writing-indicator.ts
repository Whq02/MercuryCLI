#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const { liveTurnStateOf } = await import('../../src/utils/conversationRecovery.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
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
  process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
  mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
  const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
  const { publishSessionFacts, publishSessionTail } = await import('../../src/services/engine-connector/seatProjections.ts')
  const sessionId = 'writing-indicator'
  const seat = new DaemonSessionConnector({ sessionId, runnerId: 'runner-1', title: 'the chat', projectLabel: 'proof', workspaceId: scratch, home: scratch })
  const reads = seat as unknown as { readFacts(): void; readTail(): void }
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
    reads.readFacts()
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
  rmSync(scratch, { recursive: true, force: true })
}

section('W3 the Chat hands the spinner all three live phases')
{
  const src = readFileSync(join(ROOT, 'src/screens/Chat.tsx'), 'utf8')
  check(
    "the 'tool' phase maps to the dedicated 'tool-use' spinner mode",
    src.includes("seatLive.phase === 'tool' ? 'tool-use'"),
  )
  check(
    'the thinking arm survives beside it',
    src.includes("seatLive.phase === 'thinking' ? 'thinking'"),
  )
}

section('W4 the streaming hold row IS the writing indicator')
{
  const src = readFileSync(join(ROOT, 'src/components/Spinner/StreamingHoldRow.tsx'), 'utf8')
  check(
    'the row reads the live token count (the same ref the spinner polls)',
    src.includes('responseLengthRef'),
  )
  check(
    'the count paints as tokens beside the clock',
    src.includes('tokens'),
  )
  check(
    "still-waiting derives from the count's own movement, not the process-local pulse",
    !src.includes('getPulsePhase') && !src.includes('getPulseActivity'),
  )
  const repl = readFileSync(join(ROOT, 'src/screens/Chat.tsx'), 'utf8')
  check(
    'the Chat feeds the hold row the live ref',
    /StreamingHoldRow[\s\S]{0,220}responseLengthRef=\{responseLengthRef\}/.test(repl),
  )
}

console.log(
  failures === 0
    ? '\n ✅ WRITING INDICATOR — thinking before the first token, tools as tools, and a count that moves while the agent writes'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
