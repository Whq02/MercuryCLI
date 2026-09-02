#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
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
  const src = readFileSync(join(ROOT, 'src/services/engine-connector/daemonConnector.ts'), 'utf8')
  check(
    "the union stamps 'thinking' when busy over an idle fold (dispatched, nothing streamed)",
    /this\.liveState\.phase === 'idle'\s*\?\s*'thinking'/.test(src),
  )
  check(
    "…the compacting window keeps the fold's own word (never the thinking dress)",
    /this\.liveStateWord === 'compacting'\s*\?\s*'compacting'/.test(src),
  )
  check(
    "…and no code path stamps 'responding' from the busy bit",
    !/phase === 'idle'\s*\?\s*'responding'/.test(src),
  )
}

section('W3 the REPL hands the spinner all three live phases')
{
  const src = readFileSync(join(ROOT, 'src/screens/REPL.tsx'), 'utf8')
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
  const repl = readFileSync(join(ROOT, 'src/screens/REPL.tsx'), 'utf8')
  check(
    'the REPL feeds the hold row the live ref',
    /StreamingHoldRow[\s\S]{0,220}responseLengthRef=\{responseLengthRef\}/.test(repl),
  )
}

console.log(
  failures === 0
    ? '\n ✅ WRITING INDICATOR — thinking before the first token, tools as tools, and a count that moves while the agent writes'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
