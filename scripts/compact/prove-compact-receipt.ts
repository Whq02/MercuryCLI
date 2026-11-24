#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const ambient of [
  'MERCURY_MODEL',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_SCRIPTED_STREAM',
  'MERCURY_BARE',
  'MERCURY_MAX_OUTPUT_TOKENS',
  'MERCURY_HOME',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_THINKING_BUDGET',
  'GOOGLE_API_KEY',
  'MERCURY_CONCOURSE_WORKER',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'compact-receipt-'))
process.env.MERCURY_COMPACT_KEEP_TAIL = '1'

const FIXTURE_PORT = 0

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

const receiptHint = ' | fix manualCompactDisplayText in src/engine/compaction/manualReceipt.ts'
const cardHint = ' | fix enrichSummaryForLiveDisplay and shouldEnrichForLiveDisplay in src/commands/compact/compact.ts and src/engine/compaction/manualReceipt.ts'

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — compact receipt prover exceeded 120s; look for a hung compact call in src/commands/compact/compact.ts or the fixture in scripts/lib/crossfamilyConcourseFixture.ts')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { startCrossfamilyFixture } = await import('../lib/crossfamilyConcourseFixture.ts')
const fixture = await startCrossfamilyFixture({ port: FIXTURE_PORT })
Object.assign(process.env, fixture.env)

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { call } = await import('../../src/commands/compact/compact.ts')
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/platform/files/fileStateCache.ts')

function makeMessages(): unknown[] {
  const out: unknown[] = []
  for (let index = 0; index < 10; index++) {
    out.push(createUserMessage({ content: `operator ask number ${index}: adjust module ${index} and run its checks` }))
    out.push({
      type: 'assistant',
      uuid: `00000000-0000-4000-a000-0000000000${String(10 + index)}`,
      requestId: `req_r${index}`,
      message: {
        id: `msg_r${index}`,
        type: 'message',
        role: 'assistant',
        model: 'fixture',
        content: [{ type: 'text', text: `Adjusted module ${index} and its checks pass — details recorded. ${index === 0 ? 'The module change and its checks. '.repeat(1_500) : ''}` }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 14_000 + index, output_tokens: 60 },
      },
    })
  }
  return out
}

function makeCommandContext(model: string): Record<string, unknown> {
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
  const readFileState = new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024)
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: makeMessages(),
    agentType: undefined,
    agentId: undefined,
    readFileState,
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

type CompactCallResult = {
  type: string
  displayText?: string
  foldHandoff?: {
    summaryMessages?: Array<{
      isVisibleInTranscriptOnly?: true
      summarizeMetadata?: { messagesSummarized?: number; contextReclaimedPct?: number; tokensBefore?: number; tokensAfter?: number; keptMessages?: number }
    }>
    messagesToKeep?: unknown[]
  }
}

section('R1+R2 the hosted seat — the receipt speaks and the card metadata lands')
process.env.MERCURY_CONCOURSE_WORKER = '1'
{
  const result = (await call('', makeCommandContext('claude-opus-4-8') as never)) as CompactCallResult
  const text = result.displayText ?? ''
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '')
  check('the command answered a compact result', result.type === 'compact', 'type=' + result.type + ' | the call in src/commands/compact/compact.ts must return type compact')
  check('R1 the receipt names the folded count', /folded \d+ messages? into the summary/.test(plain), plain + receiptHint)
  check('R1 the receipt carries the weight arrow (before → after tokens)', /context \S+ → \S+ tokens/.test(plain), plain + receiptHint)
  check('R1 the receipt names the verbatim tail survival', /last \d+ messages? kept verbatim/.test(plain), plain + receiptHint)
  check('R1 the receipt names where the retained summary is readable', /reads the full summary — what the agent retains/.test(plain), plain + receiptHint + ' (the transcript hint prints when shouldEnrichForLiveDisplay is true and verbose is off)')
  check('R1 the bare word alone is gone', plain.trim() !== 'Compacted', plain + receiptHint)

  const summaries = result.foldHandoff?.summaryMessages ?? []
  const summary = summaries[0]
  check('R2 the summary row exists', summary !== undefined, 'no summary message in foldHandoff.summaryMessages | check the result built by call in src/commands/compact/compact.ts')
  check(
    'R2 hosted seat: the summary row is UN-hidden (the cockpit paints the card)',
    summary !== undefined && summary.isVisibleInTranscriptOnly !== true,
    JSON.stringify({ hidden: summary?.isVisibleInTranscriptOnly }) + cardHint,
  )
  const meta = summary?.summarizeMetadata
  check('R2 the card metadata carries the folded count', typeof meta?.messagesSummarized === 'number' && meta.messagesSummarized > 0, JSON.stringify(meta) + cardHint)
  check('R2 the card metadata carries the real reclaim pct', typeof meta?.contextReclaimedPct === 'number', JSON.stringify(meta) + cardHint)
  check(
    'R2 the card metadata carries the weights (before/after)',
    typeof meta?.tokensBefore === 'number' && typeof meta?.tokensAfter === 'number',
    JSON.stringify(meta) + cardHint,
  )
  const kept = result.foldHandoff?.messagesToKeep?.length ?? 0
  check('R2 the verbatim tail rode the fold (kept > 0 — the fixture has ten rounds)', kept > 0, `kept=${kept}` + cardHint)
  check('R2 the card metadata names the kept count', meta?.keptMessages === kept, JSON.stringify({ meta, kept }) + cardHint)
}

section('R3 the plain run world — the transcript-only summary stands (SDK contract)')
delete process.env.MERCURY_CONCOURSE_WORKER
{
  const result = (await call('', makeCommandContext('claude-opus-4-8') as never)) as CompactCallResult
  const summary = (result.foldHandoff?.summaryMessages ?? [])[0]
  check('the command answered a compact result', result.type === 'compact', 'type=' + result.type + ' | the call in src/commands/compact/compact.ts must return type compact')
  check(
    'R3 plain headless: the summary row STAYS transcript-only',
    summary !== undefined && summary.isVisibleInTranscriptOnly === true,
    JSON.stringify({ hidden: summary?.isVisibleInTranscriptOnly }) + cardHint,
  )
  const plain = (result.displayText ?? '').replace(/\x1b\[[0-9;]*m/g, '')
  check('R3 …and the receipt line still speaks the numbers (scrollback truth)', /context \S+ → \S+ tokens/.test(plain), plain + receiptHint)
  check('R3 headless receipt never advertises an interactive transcript key', !plain.includes('reads the full summary') && !plain.includes('ctrl+o'), plain + receiptHint)
}


await fixture.close()
clearTimeout(guard)

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
if (failures === 0) {
  console.log(' ✅ COMPACT RECEIPT GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} COMPACT RECEIPT FAILURE(S)`)
process.exit(1)
