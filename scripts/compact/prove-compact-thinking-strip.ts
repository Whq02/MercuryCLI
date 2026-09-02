#!/usr/bin/env bun
// ============================================================================
//  scripts/compact/prove-compact-thinking-strip.ts — the compaction-side half
//  of the preserved-thinking contract (Claude Fable 5.1 binds every thinking
//  block to the prefix that produced it): a client-side edit of the history
//  strips the thinking run it invalidates, at the edit's own owner.
//
//    §1 the time-based clearing projection — a cleared tool result at index
//       k strips thinking from k onward; the assistant before k keeps its
//       block by reference; text stays.
//    §2 full compaction with the verbatim tail — the kept rounds land BEHIND
//       the fresh summary, so they carry no thinking (text and tool calls
//       stay); the input history is never mutated.
//    §3 partial compaction — the 'to' direction re-homes its kept rounds
//       behind the summary and strips them; the 'from' direction keeps its
//       prefix in place and strips nothing.
//    §4 the consumers (structural) — the three owners call the one strip.
//
//  Drives the REAL compactConversation / partialCompactConversation against
//  the deterministic fixture API (scripts/lib/fixtureApi.ts). Run:
//    ~/.bun/bin/bun run scripts/compact/prove-compact-thinking-strip.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'compact-thinking-strip-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'
// The time-based trigger through its registered flag (60-minute gap, keep the
// 5 most recent); the verbatim tail through its explicit opt-in.
process.env.MERCURY_TIME_BASED_MC = '1'
process.env.MERCURY_COMPACT_KEEP_TAIL = '1'
delete process.env.MERCURY_THINKING_BINDING

import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

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

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — compact thinking-strip proofs exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

type Block = Record<string, unknown>
type Msg = Record<string, unknown>
const THINK = (text: string): Block => ({ type: 'thinking', thinking: text, signature: 'sig-' + text })
const TEXT = (text: string): Block => ({ type: 'text', text })
let seq = 0
const uuidOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function user(content: Block[] | string, timestamp: string): Msg {
  seq++
  return { type: 'user', uuid: uuidOf(seq), timestamp, message: { role: 'user', content } }
}
function assistant(content: Block[], timestamp: string): Msg {
  seq++
  return {
    type: 'assistant',
    uuid: uuidOf(seq),
    timestamp,
    requestId: `req_${seq}`,
    message: {
      id: `msg_${seq}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-fable-5-1',
      content,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  }
}
const blocksOf = (m: unknown): Block[] => {
  const content = (m as { message?: { content?: unknown } })?.message?.content
  return Array.isArray(content) ? (content as Block[]) : []
}
const hasThinking = (m: unknown): boolean => blocksOf(m).some(b => b.type === 'thinking' || b.type === 'redacted_thinking')
const textsOf = (m: unknown): string[] => blocksOf(m).filter(b => b.type === 'text').map(b => String(b.text))

// ============================================================================
section('§1 the time-based clearing projection strips from the first cleared message')
// ============================================================================
{
  const { projectTimeBasedMicrocompact } = await import('../../src/services/compact/microCompact.ts')
  const OLD = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
  const big = 'x'.repeat(4000)
  const ids = ['bash_1', 'bash_2', 'bash_3', 'bash_4', 'bash_5', 'bash_6', 'bash_7']
  const history = [
    user('go', OLD),
    assistant([THINK('plan the seven commands'), ...ids.map(id => ({ type: 'tool_use', id, name: 'Bash', input: { command: id } }))], OLD),
    user(ids.map(id => ({ type: 'tool_result', tool_use_id: id, content: big })), OLD),
    assistant([THINK('all seven ran'), TEXT('done')], OLD),
  ]
  const projected = projectTimeBasedMicrocompact(history as never, 'repl_main_thread_prompt')
  check('the clearing pass armed for the fixture', projected !== null, 'projection returned null with MERCURY_TIME_BASED_MC=1')
  if (projected !== null) {
    check('two results cleared (seven compactable, keep the recent five)', projected.cleared === 2, String(projected.cleared))
    check('the cleared message (index 2) is a fresh object; the edit lands there', projected.messages[2] !== history[2])
    check('the assistant BEFORE the edit keeps its thinking, by reference', projected.messages[1] === history[1] && hasThinking(projected.messages[1]))
    check('the assistant AFTER the edit loses its thinking', !hasThinking(projected.messages[3]))
    check('…and keeps its text', j(textsOf(projected.messages[3])) === j(['done']))
    check('the input history is never mutated', hasThinking(history[3]))
  }
}

// ── the compaction harness (the compaction-transaction prover's shape) ──────
const { compactConversation, partialCompactConversation } = await import('../../src/services/compact/compact.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

function makeContext(): Record<string, unknown> {
  const toolPermissionContext = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
  const appState = {
    toolPermissionContext,
    sessionHooks: new Map(),
    denialTracking: undefined,
    tasks: {},
    mcp: { clients: [], tools: [], commands: [], resources: {} },
  }
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    agentId: undefined,
    readFileState: new Map<string, unknown>(),
    options: {
      tools: [],
      mcpClients: [],
      mainLoopModel: 'claude-fable-5-1',
      maxThinkingTokens: 0,
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [] },
    },
  }
}
// The streaming lane rides the session's own posture (cacheSafeParams.systemPrompt).
const CACHE_SAFE = { systemPrompt: ['fixture posture'] } as never

/** Nine rounds, each a user step and an assistant turn that thinks first. */
function nineRounds(): Msg[] {
  const NOW = new Date().toISOString()
  const out: Msg[] = []
  for (let r = 1; r <= 9; r++) {
    out.push(user(`step ${r}`, NOW))
    out.push(assistant([THINK(`thinking about step ${r}`), TEXT(`did step ${r}`)], NOW))
  }
  return out
}
const SUMMARY =
  'The session walked nine numbered steps in order and completed each one; the next step is the tenth. ' +
  'Key files: none. Open work: step ten.'

// ============================================================================
section('§2 full compaction — the verbatim tail carries no thinking behind the summary')
// ============================================================================
{
  const api = await startFixtureApi([{ kind: 'text', text: SUMMARY }] as ScriptedTurn[])
  process.env.ANTHROPIC_BASE_URL = api.url
  const history = nineRounds()
  let result: Record<string, unknown> | undefined
  let error: Error | undefined
  try {
    result = (await compactConversation(history as never, makeContext() as never, CACHE_SAFE, true)) as never
  } catch (e) {
    error = e as Error
  } finally {
    await api.close()
  }
  check('compactConversation resolves', !!result && !error, (error?.stack ?? '').slice(0, 400))
  if (result) {
    const keep = (result.messagesToKeep ?? []) as Msg[]
    // A round (groupMessagesByApiRound) opens at an assistant turn and runs
    // to the next one, so it is the assistant message plus the user message
    // that follows it: six kept rounds are six assistant turns and the five
    // user steps between them — eleven messages, the last one the final
    // assistant turn.
    const keptAssistants = keep.filter(m => m.type === 'assistant').length
    check('a verbatim tail is kept (six whole rounds: six assistant turns + the five steps between)', keep.length === 11 && keptAssistants === 6, `${keep.length} messages, ${keptAssistants} assistant`)
    check('no kept message carries a thinking block', keep.length > 0 && !keep.some(hasThinking), j(keep.map(m => blocksOf(m).map(b => b.type))))
    check('the kept assistant turns keep their text', keep.filter(m => m.type === 'assistant').every(m => textsOf(m).length === 1) && textsOf(keep[keep.length - 1]).includes('did step 9'))
    check('the summary message carries the scripted text', j(result.summaryMessages ?? []).includes('nine numbered steps'))
    check('the input history is never mutated (its tail still thinks)', hasThinking(history[17]))
  }
}

// ============================================================================
section("§3 partial compaction — 'to' strips its re-homed rounds, 'from' keeps its prefix")
// ============================================================================
{
  const api = await startFixtureApi([
    { kind: 'text', text: SUMMARY },
    { kind: 'text', text: SUMMARY },
  ] as ScriptedTurn[])
  process.env.ANTHROPIC_BASE_URL = api.url
  const history = nineRounds()
  let to: Record<string, unknown> | undefined
  let from: Record<string, unknown> | undefined
  let error: Error | undefined
  try {
    to = (await partialCompactConversation(history as never, 6, makeContext() as never, CACHE_SAFE, undefined, 'to')) as never
    from = (await partialCompactConversation(history as never, 12, makeContext() as never, CACHE_SAFE, undefined, 'from')) as never
  } catch (e) {
    error = e as Error
  } finally {
    await api.close()
  }
  check('both partial compactions resolve', !!to && !!from && !error, (error?.stack ?? '').slice(0, 400))
  if (to) {
    const kept = (to.messagesToKeep ?? []) as Msg[]
    check("'to' keeps the rounds after the pivot (twelve messages)", kept.length === 12, String(kept.length))
    check("'to' kept rounds carry no thinking (they land behind the summary)", kept.length > 0 && !kept.some(hasThinking))
    check("'to' kept assistant turns keep their text", kept.filter(m => m.type === 'assistant').every(m => textsOf(m).length === 1))
  }
  if (from) {
    const kept = (from.messagesToKeep ?? []) as Msg[]
    check("'from' keeps the prefix before the pivot (twelve messages)", kept.length === 12, String(kept.length))
    check("'from' kept rounds KEEP their thinking (the prefix stays in place)", kept.filter(m => m.type === 'assistant').every(hasThinking))
  }
  check('the input history is never mutated', hasThinking(history[1]) && hasThinking(history[17]))
}

// ============================================================================
section('§4 the consumers (structural) — three owners, one strip')
// ============================================================================
{
  const compact = readFileSync(join(ROOT, 'src/services/compact/compact.ts'), 'utf8')
  const micro = readFileSync(join(ROOT, 'src/services/compact/microCompact.ts'), 'utf8')
  const media = readFileSync(join(ROOT, 'src/services/providers/anthropic/media.ts'), 'utf8')
  check('compact.ts strips the verbatim tail from zero', compact.includes('stripThinkingFromIndex(tail.keep, 0)'))
  check("compact.ts strips the 'to' kept rounds from zero", /kept = stripThinkingFromIndex\(/.test(compact))
  check('microCompact.ts strips from the first cleared message', micro.includes('stripThinkingFromIndex(projected, firstCleared)'))
  check('media.ts strips from the first edited message', media.includes('stripThinkingFromIndex(stripped, firstEdited)'))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ COMPACT THINKING-STRIP GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ ${failures} COMPACT THINKING-STRIP FAILURE(S) (${checks} checks)`)
process.exit(1)
