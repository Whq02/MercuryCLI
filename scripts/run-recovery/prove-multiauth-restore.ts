#!/usr/bin/env bun
// ============================================================================
//  scripts/run-recovery/prove-multiauth-restore.ts — the multi-auth restore
// centrepiece.
//
//  ORACLE: session restore rebuilds ANY session whole, whatever mix of wire
//  dialects served its turns. Two fixture session records are written as real
//  transcript JSONL and restored through the REAL loader chain
//  (loadConversationForResume → walk → chain → deserialize):
//
//    1. the census session — turns from all three dialects (Anthropic
//       Messages · OpenAI Responses with an apexProviderTurn replay record ·
//       a chat-completions carrier with NO usage reported), a mid-session
//       model switch, a PARALLEL tool round, a parallel TodoWrite round, an
//       errored tool round, a compaction boundary + summary, and an
//       interrupted tail;
//    2. TODAY's shape — the operator's real session: started on
//       Ox Alpha (openrouter/stealth/ox-alpha), switched to GPT-5.6
//       mid-session, ran an Agent workflow twice (one child's wire reported
//       usage, one reported none), carries a PRIOR resume's synthetic rows,
//       ends clean.
//
//  Asserted together, per record: the transcript is WHOLE (every fixture row
//  exactly once — nothing dropped, nothing doubled; resume synthesis adds
//  only its two contracted rows); dialect-specific fields survive verbatim
//  (apexProviderTurn items + provider usage receipt; ABSENT usage stays
//  absent — never fabricated); conversation-model retention returns the last
//  SERVED id whatever its family spelling; the resume recap is right (turns ·
//  files · failures · gap · top tools); tool-result summaries are truthful
//  per dialect and total over corrupt shapes; the parallel-round todo law
//  holds (last write in the round wins).
//
//  Hermetic: scratch MERCURY_CONFIG_DIR from mkdtemp before any src import,
//  scratch cwd (no project hooks), no network, no PTY, no live providers.
//
//  Run:  ~/.bun/bin/bun run scripts/run-recovery/prove-multiauth-restore.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'june-multiauth-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'june-multiauth-daemon-'))
for (const k of ['MERCURY_SIMPLE', 'ANTHROPIC_MODEL', 'CLAUDE_TEAM_NAME', 'CLAUDE_AGENT_NAME', 'NODE_ENV']) {
  delete process.env[k]
}
const scratch = mkdtempSync(join(tmpdir(), 'june-multiauth-cwd-'))
process.chdir(scratch)

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { loadConversationForResume } = await import('../../src/utils/conversationRecovery.ts')
const { extractTodosFromMessages, restoreConversationModelFromMessages } = await import(
  '../../src/utils/sessionRestore.ts'
)
const { buildAwayRecap } = await import('../../src/utils/cockpit/awaySummary.ts')
const { summarizeToolResult } = await import('../../src/utils/toolResultSummary.ts')
const { SYNTHETIC_MODEL } = await import('../../src/utils/messages/factories.ts')
import type { Message } from '../../src/types/message.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures = 1
}

// ── fixture machinery ───────────────────────────────────────────────────────

const T0 = Date.parse('2026-08-25T09:00:00.000Z')
const STEP = 30_000
let clock = 0
const nextTs = (): string => new Date(T0 + STEP * clock++).toISOString()

// Tag → uuid registry: every assertion addresses rows by TAG, so an index can
// never drift onto the wrong row (the vacuous-pass class).
let uuidCounter = 0
const U: Record<string, string> = {}
function uid(tag: string): string {
  const uuid = `00000000-0000-4000-8000-${String(100000000000 + ++uuidCounter).slice(1)}`
  U[tag] = uuid
  return uuid
}

type Row = Record<string, unknown>
function chainRows(sessionId: string, rows: Row[]): Row[] {
  let parent: string | null = null
  return rows.map(row => {
    const uuid = row['uuid'] as string
    const out: Row = {
      parentUuid: parent,
      isSidechain: false,
      userType: 'external',
      cwd: scratch,
      sessionId,
      version: '1.0.0-beta.1',
      gitBranch: 'main',
      timestamp: nextTs(),
      ...row,
    }
    parent = uuid
    return out
  })
}

const asst = (
  tag: string,
  model: string,
  content: unknown[],
  extra: Row = {},
  usage?: Record<string, unknown>,
): Row => ({
  uuid: uid(tag),
  type: 'assistant',
  requestId: `req_${tag}`,
  message: {
    id: `msg_${tag}`,
    type: 'message',
    role: 'assistant',
    model,
    stop_reason: null,
    stop_sequence: null,
    container: null,
    context_management: null,
    content,
    ...(usage !== undefined ? { usage } : {}),
  },
  ...extra,
})

const user = (tag: string, content: unknown, extra: Row = {}): Row => ({
  uuid: uid(tag),
  type: 'user',
  message: { role: 'user', content },
  ...extra,
})

const toolResult = (tag: string, toolUseId: string, text: string, structured?: unknown, isError?: boolean): Row =>
  user(
    tag,
    [{ type: 'tool_result', tool_use_id: toolUseId, ...(isError ? { is_error: true } : {}), content: [{ type: 'text', text }] }],
    structured !== undefined ? { toolUseResult: structured } : {},
  )

const use = (id: string, name: string, input: unknown): Row => ({ type: 'tool_use', id, name, input })

const modelSwitch = (tag: string, previous: string, applied: string): Row => ({
  uuid: uid(tag),
  type: 'system',
  subtype: 'model_transition',
  previous,
  requested: applied,
  applied,
  resolution: 'applied',
  boundary: 'idle',
  crossProvider: true,
  cacheDisposition: 'fresh-lane',
  isMeta: true,
})

// ── fixture 1 · the census session (all three dialects + compaction) ────────

const SID1 = 'aaaaaaaa-1111-4000-8000-000000000001'
const APEX_TURN = {
  provider: 'openai',
  responseId: 'resp_fx1',
  items: [
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-opaque' },
    { type: 'function_call', call_id: 'g1', name: 'Grep', arguments: '{"pattern":"foo"}' },
  ],
  contractDigest: 'digest-a',
  providerUsage: { inputTokensTotal: 1200, cachedInputTokens: 200, outputTokens: 80 },
}
const CANON_USAGE = { input_tokens: 1000, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 200 }

const f1 = chainRows(SID1, [
  user('f1upre', 'warm up'),
  asst('f1apre', 'claude-opus-5', [{ type: 'text', text: 'ok' }], {}, CANON_USAGE),
  {
    uuid: uid('f1bound'),
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Compacted',
    level: 'info',
    isMeta: true,
    compactMetadata: { trigger: 'manual', preTokens: 180_000 },
  },
  user('f1summ', 'Summary of the earlier work: checks were prepared.', { isCompactSummary: true }),
  user('f1u1', 'run the checks'),
  asst('f1a1', 'claude-opus-5', [
    { type: 'thinking', thinking: 'plan the round', signature: '' },
    { type: 'text', text: 'Running.' },
    use('b1', 'Bash', { command: 'echo ok' }),
    use('b2', 'Bash', { command: 'git status --short' }),
  ]),
  toolResult('f1r1a', 'b1', 'ok', { stdout: 'ok', stderr: '', interrupted: false, isImage: false, noOutputExpected: false }),
  toolResult('f1r1b', 'b2', 'clean', { stdout: 'clean', stderr: '', interrupted: false, isImage: false, noOutputExpected: false }),
  modelSwitch('f1sw', 'claude-opus-5', 'gpt-5.6-sol'),
  user('f1u2', 'search the estate'),
  asst(
    'f1a2',
    'gpt-5.6-sol',
    [{ type: 'text', text: 'Searching.' }, use('g1', 'Grep', { pattern: 'foo' })],
    { apexProviderTurn: APEX_TURN },
    CANON_USAGE,
  ),
  toolResult('f1r2', 'g1', '3 files', { mode: 'files_with_matches', numFiles: 3, filenames: ['a', 'b', 'c'] }),
  asst('f1a3', 'gpt-5.6-sol', [
    use('td1', 'TodoWrite', { todos: [{ content: 'stale item', status: 'pending', activeForm: 'staling' }] }),
    use('td2', 'TodoWrite', {
      todos: [
        { content: 'first', status: 'completed', activeForm: 'firsting' },
        { content: 'second', status: 'in_progress', activeForm: 'seconding' },
      ],
    }),
  ]),
  toolResult('f1r3a', 'td1', 'Todos updated'),
  toolResult('f1r3b', 'td2', 'Todos updated'),
  asst('f1a4', 'gpt-5.6-sol', [use('bx', 'Bash', { command: 'rm protected' })]),
  toolResult('f1rx', 'bx', 'Error: denied', undefined, true),
  user('f1u3', 'read the file'),
  asst('f1a5', 'openrouter/stealth/ox-alpha', [use('rd1', 'Read', { file_path: '/x/f.ts' })]),
  toolResult('f1r5', 'rd1', 'read', { type: 'text', file: { filePath: '/x/f.ts', content: 'x', numLines: 12 } }),
])
const F1_LAST_TS = T0 + STEP * (clock - 1)

// ── fixture 2 · TODAY's shape (Ox Alpha → GPT-5.6, resumed workflow) ────────

const SID2 = 'bbbbbbbb-2222-4000-8000-000000000002'
const AGENT_RECORD_USAGE = {
  status: 'completed',
  prompt: 'verify the estate',
  content: [{ type: 'text', text: 'done' }],
  totalDurationMs: 60_000,
  totalTokens: 45_230,
  totalToolUseCount: 12,
}
const AGENT_RECORD_NO_USAGE = {
  status: 'completed',
  prompt: 'sweep the estate',
  content: [{ type: 'text', text: 'done' }],
  totalDurationMs: 42_000,
  totalTokens: 0,
  totalToolUseCount: 7,
}

const f2 = chainRows(SID2, [
  user('f2u1', 'start the survey'),
  asst('f2a1', 'openrouter/stealth/ox-alpha', [{ type: 'text', text: 'On it.' }]),
  user('f2u2', 'read main and search'),
  asst('f2a2', 'openrouter/stealth/ox-alpha', [use('rd', 'Read', { file_path: '/y/main.ts' })]),
  toolResult('f2r2', 'rd', 'read', { type: 'text', file: { filePath: '/y/main.ts', content: 'y', numLines: 7 } }),
  modelSwitch('f2sw', 'openrouter/stealth/ox-alpha', 'gpt-5.6-sol'),
  asst(
    'f2a3',
    'gpt-5.6-sol',
    [use('pb', 'Bash', { command: 'echo hi' }), use('pg', 'Grep', { pattern: 'bar' })],
    { apexProviderTurn: { provider: 'openai', items: [{ type: 'function_call', call_id: 'pb', name: 'Bash', arguments: '{}' }] } },
  ),
  toolResult('f2r3a', 'pb', 'hi', { stdout: 'hi', stderr: '', interrupted: false, isImage: false, noOutputExpected: false }),
  toolResult('f2r3b', 'pg', 'no matches', { mode: 'content', numFiles: 0, filenames: [], numLines: 0 }),
  asst('f2a4', 'gpt-5.6-sol', [use('w1', 'Agent', { description: 'verify estate', prompt: 'verify the estate' })]),
  toolResult('f2r4', 'w1', 'agent done', AGENT_RECORD_USAGE),
  // A PRIOR resume left its two synthetic rows mid-transcript.
  user('f2cont', 'Continue from where you left off.', { isMeta: true }),
  asst('f2sent', SYNTHETIC_MODEL, [{ type: 'text', text: 'No response requested.' }]),
  asst('f2a5', 'gpt-5.6-sol', [use('w2', 'Agent', { description: 'sweep estate', prompt: 'sweep the estate' })]),
  toolResult('f2r5', 'w2', 'agent done', AGENT_RECORD_NO_USAGE),
  asst('f2a6', 'gpt-5.6-sol', [{ type: 'text', text: 'Survey complete.' }]),
])
const F2_LAST_TS = T0 + STEP * (clock - 1)

// The fixture rows are in-memory entries; the files are REAL transcript
// record JSONL — encoded through the writer's own seam, exactly as a live
// session persists them.
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
const f1Path = join(scratch, `${SID1}.jsonl`)
const f2Path = join(scratch, `${SID2}.jsonl`)
writeFileSync(f1Path, f1.map(r => encodeTranscriptLine(f1Path, r).line).join(''))
writeFileSync(f2Path, f2.map(r => encodeTranscriptLine(f2Path, r).line).join(''))

// ── restore both records through the REAL loader chain ──────────────────────

const loaded1 = await loadConversationForResume('fixture-1', f1Path)
const loaded2 = await loadConversationForResume('fixture-2', f2Path)
if (!loaded1 || !loaded2) {
  console.log('  [FAIL] loader returned null for a fixture record')
  process.exit(1)
}

const counts = (messages: Message[]): Map<string, number> => {
  const map = new Map<string, number>()
  for (const m of messages) {
    const u = (m as { uuid?: string }).uuid ?? '(none)'
    map.set(u, (map.get(u) ?? 0) + 1)
  }
  return map
}
const rowOf = (messages: Message[], tag: string): Row | undefined =>
  messages.find(m => (m as { uuid?: string }).uuid === U[tag]) as Row | undefined
const structuredOf = (messages: Message[], tag: string): unknown =>
  (rowOf(messages, tag) as { toolUseResult?: unknown } | undefined)?.toolUseResult

console.log('\n§1 · the census session: the transcript is whole')
{
  const got = counts(loaded1.messages)
  const missing = f1.filter(r => got.get(r['uuid'] as string) !== 1)
  check(
    `every fixture row exactly once (${f1.length} rows — nothing dropped, nothing doubled)`,
    missing.length === 0,
    missing.map(r => `${r['uuid']} ×${got.get(r['uuid'] as string) ?? 0}`).join(', '),
  )
  const extras = loaded1.messages.filter(m => !f1.some(r => r['uuid'] === (m as { uuid?: string }).uuid))
  check('resume synthesis adds exactly its two contracted rows', extras.length === 2, `${extras.length} extras`)
  const cont = extras[0] as { type?: string; isMeta?: boolean; message?: { content?: unknown } } | undefined
  const sent = extras[1] as { type?: string; message?: { content?: unknown; model?: string } } | undefined
  const contBlocks = cont?.message?.content
  check(
    'the continuation row is the isMeta resume prompt',
    cont?.type === 'user' &&
      cont?.isMeta === true &&
      Array.isArray(contBlocks) &&
      (contBlocks[0] as { text?: string })?.text === 'Continue from where you left off.',
  )
  const sentBlocks = sent?.message?.content
  check(
    'the sentinel row is the synthetic no-response assistant',
    sent?.type === 'assistant' &&
      sent?.message?.model === SYNTHETIC_MODEL &&
      Array.isArray(sentBlocks) &&
      (sentBlocks[0] as { text?: string })?.text === 'No response requested.',
  )
  check(
    'the tail is an interrupted prompt (the continuation itself)',
    loaded1.turnInterruptionState.kind === 'interrupted_prompt',
  )
  check('the walk adopts the transcript tip session id', String(loaded1.sessionId) === SID1)
  check(
    'the compact boundary and its summary row each survive once',
    got.get(U['f1bound']!) === 1 && got.get(U['f1summ']!) === 1,
  )
}

console.log('\n§2 · dialect fields survive verbatim; absent stays absent')
{
  const a2 = rowOf(loaded1.messages, 'f1a2') as
    | { apexProviderTurn?: typeof APEX_TURN; message?: { usage?: unknown } }
    | undefined
  check(
    'the Responses turn keeps its apexProviderTurn replay record whole',
    JSON.stringify(a2?.apexProviderTurn) === JSON.stringify(APEX_TURN),
  )
  check(
    "the provider usage receipt survives (the wire's own reporting location)",
    a2?.apexProviderTurn?.providerUsage?.inputTokensTotal === 1200 &&
      a2?.apexProviderTurn?.providerUsage?.cachedInputTokens === 200,
  )
  // Key order is the codec's (the usage lift re-emits in its own order);
  // the FIELDS and VALUES are exact — compare order-agnostically.
  const sortedJson = (v: unknown): string =>
    JSON.stringify(v, v && typeof v === 'object' ? Object.keys(v as object).sort() : undefined)
  check('the canonical usage envelope survives beside it', sortedJson(a2?.message?.usage) === sortedJson(CANON_USAGE))
  const a5 = rowOf(loaded1.messages, 'f1a5') as { message?: object } | undefined
  check(
    'the carrier turn that reported NO usage restores with usage ABSENT — never a fabricated envelope',
    a5?.message !== undefined && !('usage' in a5.message),
  )
}

console.log('\n§3 · conversation-model retention across families')
{
  check(
    'the census session retains the LAST served id — the slash-form carrier (the pre-rewrite gate restored the default here)',
    restoreConversationModelFromMessages(loaded1.messages) === 'openrouter/stealth/ox-alpha',
  )
  check(
    "today's shape retains gpt-5.6-sol (the resume sentinel's synthetic model is skipped by provenance)",
    restoreConversationModelFromMessages(loaded2.messages) === 'gpt-5.6-sol',
  )
}

console.log('\n§4 · the resume recap is right (census session)')
{
  const NOW = F1_LAST_TS + 2 * 3600_000
  const recap = buildAwayRecap(loaded1.messages, NOW, null)
  check('a recap exists', recap !== null)
  check('turns count the operator turns only (4 — the compact summary and synthetics excluded)', recap?.turns === 4, String(recap?.turns))
  check('the errored round is a counted failure', recap?.toolFailures === 1, String(recap?.toolFailures))
  check('the prior run did not end on an error', recap?.endedOnError === false)
  check('files touched counts the one real file', recap?.filesTouched === 1, String(recap?.filesTouched))
  check('top tools are honest counts', recap?.topTools === 'Bash×3 Grep×1 Read×1', recap?.topTools)
  check(
    'the last-active clock reads the prior run, not the resume synthetics',
    recap?.lastActiveGapMs === NOW - F1_LAST_TS,
    String(recap?.lastActiveGapMs),
  )
  check('the line carries the failure truth', recap?.line.includes('1 tool call failed') === true, recap?.line)
}

console.log("\n§5 · today's shape: whole, clean tail, recap right")
{
  const got = counts(loaded2.messages)
  const missing = f2.filter(r => got.get(r['uuid'] as string) !== 1)
  check(
    `every fixture row exactly once (${f2.length} rows — the prior resume's synthetics included)`,
    missing.length === 0,
    missing.map(r => `${r['uuid']} ×${got.get(r['uuid'] as string) ?? 0}`).join(', '),
  )
  check('a clean tail adds nothing', loaded2.messages.length === f2.length, String(loaded2.messages.length))
  check('no interruption on a clean tail', loaded2.turnInterruptionState.kind === 'none')
  const NOW = F2_LAST_TS + 45 * 60_000
  const recap = buildAwayRecap(loaded2.messages, NOW, null)
  check('turns: 2 operator turns (the prior-resume continuation is meta)', recap?.turns === 2, String(recap?.turns))
  check('top tools count the workflow rounds', recap?.topTools === 'Agent×2 Bash×1 Grep×1', recap?.topTools)
  check('no failures, no error end', recap?.toolFailures === 0 && recap?.endedOnError === false)
  check(
    'the last-active clock reads the real tail',
    recap?.lastActiveGapMs === NOW - F2_LAST_TS,
    String(recap?.lastActiveGapMs),
  )
  const r4 = structuredOf(loaded2.messages, 'f2r4') as { totalTokens?: number } | undefined
  const r5 = structuredOf(loaded2.messages, 'f2r5') as { totalTokens?: number } | undefined
  check('the usage-reporting workflow record survives with its real count', r4?.totalTokens === 45_230)
  check('the usage-less workflow record survives with its honest zero', r5?.totalTokens === 0)
}

console.log('\n§6 · tool-result summaries are truthful per dialect')
{
  check(
    'Anthropic parallel Bash round: both one-liners, verbatim',
    summarizeToolResult('Bash', structuredOf(loaded1.messages, 'f1r1a')) === 'ok' &&
      summarizeToolResult('Bash', structuredOf(loaded1.messages, 'f1r1b')) === 'clean',
  )
  check('Responses Grep round: the real count', summarizeToolResult('Grep', structuredOf(loaded1.messages, 'f1r2')) === 'Found 3 files')
  check('carrier Read round: the real line count', summarizeToolResult('Read', structuredOf(loaded1.messages, 'f1r5')) === 'Read 12 lines')
  check(
    'an errored round carries no structured result — the seam declines',
    structuredOf(loaded1.messages, 'f1rx') === undefined &&
      summarizeToolResult('Bash', structuredOf(loaded1.messages, 'f1rx')) === null,
  )
  check(
    'a chat-completions round and a Responses round summarize as truthfully as an Anthropic one',
    summarizeToolResult('Read', structuredOf(loaded2.messages, 'f2r2')) === 'Read 7 lines' &&
      summarizeToolResult('Bash', structuredOf(loaded2.messages, 'f2r3a')) === 'hi' &&
      summarizeToolResult('Grep', structuredOf(loaded2.messages, 'f2r3b')) === 'Found 0 lines',
  )
  check(
    'the seam never invents an Agent one-liner (usage stays off the inline seam)',
    summarizeToolResult('Agent', AGENT_RECORD_USAGE) === null && summarizeToolResult('Agent', AGENT_RECORD_NO_USAGE) === null,
  )
  check(
    'total over corrupt shapes: a string result and a wire {} placeholder decline',
    summarizeToolResult('Bash', 'Error: boom') === null && summarizeToolResult('Read', {}) === null,
  )
}

console.log('\n§7 · the parallel-round todo law')
{
  const todos = extractTodosFromMessages(loaded1.messages)
  check('the LAST TodoWrite in the newest round wins', todos.length === 2 && todos[1]?.content === 'second', JSON.stringify(todos))
}

console.log()
if (failures) {
  console.log('❌ MULTIAUTH-RESTORE RED')
} else {
  console.log('✅ MULTIAUTH-RESTORE GREEN — restore rebuilds every dialect mix whole')
}
process.exit(failures)
