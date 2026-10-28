#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const ambient of [
  'MERCURY_MODEL', 'MERCURY_SMALL_FAST_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE',
  'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_HOME', 'MERCURY_EFFORT_LEVEL', 'MERCURY_THINKING_BUDGET', 'GOOGLE_API_KEY', 'MERCURY_CONCOURSE_WORKER',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'manual-compact-never-grows-'))
process.env.MERCURY_COMPACT_KEEP_TAIL = '1'

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
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — manual-compact-never-grows prover exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

const { startCrossfamilyFixture } = await import('../lib/crossfamilyConcourseFixture.ts')
const fixture = await startCrossfamilyFixture({ port: 0 })
Object.assign(process.env, fixture.env)

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { call, nothingToCompactLine, NOTHING_TO_COMPACT_KEY } = await import('../../src/commands/compact/compact.ts')
const { buildPostCompactMessages, projectManualFold, manualFoldHasNothingToFold } = await import('../../src/services/compact/compact.ts')
const { estimateContextTokens } = await import('../../src/services/compact/microCompact.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')

type AnyMsg = Record<string, unknown> & { type?: string }

function makeMessages(rounds: number, replyChars: number, lastUsage: number): AnyMsg[] {
  const out: AnyMsg[] = []
  for (let index = 0; index < rounds; index++) {
    out.push(createUserMessage({ content: `operator ask number ${index}: adjust module ${index} and run its checks` }) as AnyMsg)
    out.push({
      type: 'assistant',
      uuid: `00000000-0000-4000-a000-00000000${String(1000 + index)}`,
      requestId: `req_r${index}`,
      message: {
        id: `msg_r${index}`,
        type: 'message',
        role: 'assistant',
        model: 'fixture',
        content: [{ type: 'text', text: `Adjusted module ${index} and its checks pass. ${`module ${index} line ${'x'.repeat(40)}\n`.repeat(Math.ceil(replyChars / 60))}` }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: index === rounds - 1 ? lastUsage : 900 + index, output_tokens: 60 },
      },
    })
  }
  return out
}

function makeCommandContext(messages: AnyMsg[]): Record<string, unknown> {
  const model = 'claude-opus-4-8'
  const toolPermissionContext = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
  const appState = {
    toolPermissionContext,
    sessionHooks: new Map(),
    tasks: {},
    mcp: { clients: [], tools: [], commands: [], resources: {} },
    effortValue: 'high',
    verbose: false,
    engineModel: model,
  }
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages,
    agentType: undefined,
    agentId: undefined,
    readFileState: new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024),
    options: {
      tools: [],
      mcpClients: [],
      commands: [],
      engineModel: model,
      maxThinkingTokens: 0,
      thinkingConfig: { type: 'disabled' as const },
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [] },
    },
  }
}

type CompactCallResult = { type: string; displayText?: string; compactionResult: Parameters<typeof buildPostCompactMessages>[0] }
const plainOf = (result: CompactCallResult): string => (result.displayText ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0] ?? ''
const summaryRequests = (): number => fixture.captured.filter(hit => hit.lane.startsWith('anthropic')).length

section('A an unfolded long history: /compact folds it as today (the summariser is asked once, the context shrinks)')
const long = makeMessages(40, 1_500, 22_000)
const first = (await call('', makeCommandContext(long) as never)) as CompactCallResult
const post = buildPostCompactMessages(first.compactionResult) as AnyMsg[]
{
  const requests = summaryRequests()
  check('the fold landed with a receipt that shrinks', first.type === 'compact' && /context 22\.1k → \d+(\.\d+)?k tokens/.test(plainOf(first)), plainOf(first))
  check('ONE summariser request went out', requests === 1, String(requests))
  check('the folded context is smaller by the same estimator', estimateContextTokens(post as never) < estimateContextTokens(long as never), `${estimateContextTokens(post as never)} vs ${estimateContextTokens(long as never)}`)
}

section('B /compact straight after that fold: one line, no summariser request, the context unchanged (red on the base: a second fold ran and the receipt read a larger context)')
{
  const before = summaryRequests()
  const snapshot = JSON.stringify(post)
  const context = makeCommandContext(post)
  let threw: string | undefined
  let result: CompactCallResult | undefined
  try {
    result = (await call('', context as never)) as CompactCallResult
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  check('the command refused with the one line, as pinned', result === undefined && /^Nothing to compact: the last fold already holds this conversation \(\d+(\.\d+)?k? tokens\)$/.test(threw ?? ''), `threw=${threw ?? 'no'} result=${result ? plainOf(result) : 'none'}`)
  check('no summariser request went out', summaryRequests() === before, `${summaryRequests()} vs ${before}`)
  check('the context is unchanged', JSON.stringify(post) === snapshot && (context.messages as AnyMsg[]) === post)
  const projection = typeof projectManualFold === 'function' ? await projectManualFold(post as never, context as never, { systemPrompt: [], userContext: {}, systemContext: {}, toolUseContext: context, forkContextMessages: post } as never, undefined) : null
  check('the line carries the context size the gauge shows', projection !== null && threw === nothingToCompactLine(projection.context), `threw=${threw ?? 'no'} projection=${JSON.stringify(projection)}`)
  check('the projection says why: by one estimate the fold would not land smaller than what stands', projection !== null && manualFoldHasNothingToFold(projection) && projection.after >= projection.before, JSON.stringify(projection))
}

section('C the rule reads a conversation folded before; a conversation never folded is not refused by it, so a short one still folds as today')
{
  const short = makeMessages(10, 0, 0)
  for (const row of short) if (row.type === 'assistant') (row as { message: { usage: { input_tokens: number } } }).message.usage.input_tokens = 900
  const before = summaryRequests()
  let threw: string | undefined
  let result: CompactCallResult | undefined
  try {
    result = (await call('', makeCommandContext(short) as never)) as CompactCallResult
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  check('a never-folded conversation folds as today', threw === undefined && result?.type === 'compact' && plainOf(result).startsWith('Compacted'), `threw=${threw ?? 'no'} result=${result ? plainOf(result) : 'none'}`)
  check('ONE summariser request went out', summaryRequests() === before + 1, `${summaryRequests()} vs ${before}`)
}

section('D the line\'s shape: the key the command recognises, and the one sentence')
{
  check('the key', NOTHING_TO_COMPACT_KEY === 'Nothing to compact: ')
  check('after a fold', nothingToCompactLine(169_900) === 'Nothing to compact: the last fold already holds this conversation (169.9k tokens)', nothingToCompactLine(169_900))
}

await fixture.close()
clearTimeout(guard)
console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log(failures === 0 ? ' ✅ MANUAL COMPACT NEVER GROWS GREEN' : ` ❌ ${failures} MANUAL COMPACT NEVER GROWS FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
