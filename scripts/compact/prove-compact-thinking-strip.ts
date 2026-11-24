#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'compact-thinking-strip-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'
process.env.MERCURY_TIME_BASED_MC = '1'
process.env.MERCURY_COMPACT_KEEP_TAIL = '1'
delete process.env.MERCURY_THINKING_BINDING

import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
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

section('§1 the time-based clearing projection strips from the first cleared message')
{
  const { projectTimeBasedPrune } = await import('../../src/engine/compaction/pruneToolResults.ts')
  const OLD = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
  const big = 'x'.repeat(44_000)
  const ids = Array.from({ length: 12 }, (_, index) => `bash_${index + 1}`)
  const history = [
    user('go', OLD),
    assistant([THINK('plan the seven commands'), ...ids.map(id => ({ type: 'tool_use', id, name: 'Bash', input: { command: id } }))], OLD),
    user(ids.map(id => ({ type: 'tool_result', tool_use_id: id, content: big })), OLD),
    assistant([THINK('all seven ran'), TEXT('done')], OLD),
  ]
  const projected = projectTimeBasedPrune(history as never, 'main_thread_prompt')
  check('the clearing pass armed for the fixture', projected !== null, 'projection returned null with MERCURY_TIME_BASED_MC=1; projectTimeBasedMicrocompact in src/engine/compaction/pruneToolResults.ts must arm for six-hour-old tool results')
  if (projected !== null) {
    check('two results cleared (seven compactable, keep the recent five)', projected.cleared === 2, `${String(projected.cleared)}; projectTimeBasedMicrocompact in src/engine/compaction/pruneToolResults.ts must clear all but the recent five compactable results`)
    check('the cleared message (index 2) is a fresh object; the edit lands there', projected.messages[2] !== history[2], 'projectTimeBasedMicrocompact in src/engine/compaction/pruneToolResults.ts must return a copy of the cleared message, not the input row')
    check('the assistant BEFORE the edit keeps its thinking, by reference', projected.messages[1] === history[1] && hasThinking(projected.messages[1]), 'projectTimeBasedMicrocompact in src/engine/compaction/pruneToolResults.ts must leave messages before the first cleared one untouched')
    check('the assistant AFTER the edit loses its thinking', !hasThinking(projected.messages[3]), 'projectTimeBasedMicrocompact in src/engine/compaction/pruneToolResults.ts must strip thinking blocks from assistant messages after the first cleared one')
    const afterId = (history[3] as { message: { id: string } }).message.id
    check("the projection names the stripped block as a dead mark (the assistant after the edit, block 0) and nothing before the edit", projected.deadMarks.length === 1 && projected.deadMarks[0]!.messageId === afterId && projected.deadMarks[0]!.blockIndex === 0, `${JSON.stringify(projected.deadMarks)}; projectTimeBasedMicrocompact in src/engine/compaction/pruneToolResults.ts must report one deadMarks entry per stripped block, only after the edit`)
    check('…and keeps its text', j(textsOf(projected.messages[3])) === j(['done']), 'the thinking strip in projectTimeBasedMicrocompact (src/engine/compaction/pruneToolResults.ts) must remove thinking blocks only and keep text blocks')
    check('the input history is never mutated', hasThinking(history[3]), 'projectTimeBasedMicrocompact in src/engine/compaction/pruneToolResults.ts stripped thinking from the input message in place; copy the message before editing')
  }
}

const { foldConversation, partialFoldConversation } = await import('../../src/engine/compaction/foldConversation.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')

function makeContext(): Record<string, unknown> {
  const toolPermissionContext = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
  const appState = {
    toolPermissionContext,
    sessionHooks: new Map(),
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
      engineModel: 'claude-fable-5-1',
      maxThinkingTokens: 0,
      thinkingConfig: { type: 'adaptive' as const },
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [] },
    },
  }
}
const CACHE_SAFE = { systemPrompt: ['fixture posture'] } as never

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

section('§2 full compaction — the verbatim tail carries no thinking behind the summary')
{
  const api = await startFixtureApi([{ kind: 'text', text: SUMMARY }] as ScriptedTurn[])
  process.env.ANTHROPIC_BASE_URL = api.url
  const history = nineRounds()
  let result: Record<string, unknown> | undefined
  let error: Error | undefined
  try {
    result = (await foldConversation(history as never, makeContext() as never, CACHE_SAFE, true)) as never
  } catch (e) {
    error = e as Error
  } finally {
    await api.close()
  }
  check('compactConversation resolves', !!result && !error, `${(error?.stack ?? '').slice(0, 400)}; compactConversation in src/engine/compaction/foldConversation.ts threw against the fixture API, read the stack`)
  if (result) {
    const keep = (result.messagesToKeep ?? []) as Msg[]
    const keptAssistants = keep.filter(m => m.type === 'assistant').length
    check('the available eight complete rounds are kept behind the two head groups', keep.length === 15 && keptAssistants === 8, `${keep.length} messages, ${keptAssistants} assistant; the verbatim tail kept by compactConversation (src/engine/compaction/foldConversation.ts, MERCURY_COMPACT_KEEP_TAIL=1) changed size`)
    check('no kept message carries a thinking block', keep.length > 0 && !keep.some(hasThinking), `${j(keep.map(m => blocksOf(m).map(b => b.type)))}; thinking blocks must be stripped from messagesToKeep before compactConversation (src/engine/compaction/foldConversation.ts) returns them`)
    check('the kept assistant turns keep their text', keep.filter(m => m.type === 'assistant').every(m => textsOf(m).length === 1) && textsOf(keep[keep.length - 1]).includes('did step 9'), 'the thinking strip on the kept tail removed or altered a text block; it must drop thinking blocks only')
    check('the summary message carries the scripted text', j(result.summaryMessages ?? []).includes('nine numbered steps'), 'summaryMessages from compactConversation (src/engine/compaction/foldConversation.ts) must carry the text the fixture API returned')
    check('the input history is never mutated (its tail still thinks)', hasThinking(history[17]), 'compactConversation (src/engine/compaction/foldConversation.ts) stripped thinking from the caller\'s message in place; strip on copies')
  }
}

section("§3 partial compaction — 'to' strips its re-homed rounds, 'from' keeps its prefix")
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
    to = (await partialFoldConversation(history as never, 6, makeContext() as never, CACHE_SAFE, undefined, 'to')) as never
    from = (await partialFoldConversation(history as never, 12, makeContext() as never, CACHE_SAFE, undefined, 'from')) as never
  } catch (e) {
    error = e as Error
  } finally {
    await api.close()
  }
  check('both partial compactions resolve', !!to && !!from && !error, `${(error?.stack ?? '').slice(0, 400)}; partialCompactConversation in src/engine/compaction/fold/partialFold.ts threw against the fixture API, read the stack`)
  if (to) {
    const kept = (to.messagesToKeep ?? []) as Msg[]
    check("'to' keeps the rounds after the pivot (twelve messages)", kept.length === 12, `${String(kept.length)}; partialCompactConversation direction 'to' in src/engine/compaction/fold/partialFold.ts must keep the rounds after the pivot`)
    check("'to' kept rounds carry no thinking (they land behind the summary)", kept.length > 0 && !kept.some(hasThinking), "partialCompactConversation direction 'to' in src/engine/compaction/fold/partialFold.ts must strip thinking blocks from the rounds it re-homes behind the summary")
    check("'to' kept assistant turns keep their text", kept.filter(m => m.type === 'assistant').every(m => textsOf(m).length === 1), "the strip in partialCompactConversation (src/engine/compaction/fold/partialFold.ts) removed a text block; it must drop thinking blocks only")
  }
  if (from) {
    const kept = (from.messagesToKeep ?? []) as Msg[]
    check("'from' keeps the prefix before the pivot (twelve messages)", kept.length === 12, `${String(kept.length)}; partialCompactConversation direction 'from' in src/engine/compaction/fold/partialFold.ts must keep the prefix before the pivot`)
    check("'from' kept rounds KEEP their thinking (the prefix stays in place)", kept.filter(m => m.type === 'assistant').every(hasThinking), "partialCompactConversation direction 'from' in src/engine/compaction/fold/partialFold.ts must not strip thinking from the prefix it leaves in place")
  }
  check('the input history is never mutated', hasThinking(history[1]) && hasThinking(history[17]), 'partialCompactConversation (src/engine/compaction/fold/partialFold.ts) stripped thinking from the caller\'s messages in place; strip on copies')
}


console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ COMPACT THINKING-STRIP GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ ${failures} COMPACT THINKING-STRIP FAILURE(S) (${checks} checks)`)
process.exit(1)
