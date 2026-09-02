#!/usr/bin/env bun
// ============================================================================
//  scripts/compact/prove-compact-receipt.ts — the /compact receipt SPEAKS
//  (compact-frontier part 2, operator-ruled: the live receipt read exactly
//  "Compacted" — nothing about what was folded or what the agent retains).
//
//  The law: the visible receipt carries the fold's own numbers — the folded
//  message count, the context weight before → after (the result's real token
//  counts), the verbatim tail's survival — and names where the full summary
//  (what the agent now retains) is readable. The summary card gets the same
//  facts as metadata; the daemon-hosted seat child (the cockpit's world)
//  enriches exactly like an interactive session, while a plain headless -p
//  run keeps the transcript-only summary its consumers expect.
//
//    R1  the receipt line: folded count + weight arrow + tail survival +
//        the retention hint (driven through the REAL /compact command);
//    R2  the hosted seat (MERCURY_CONCOURSE_WORKER=1): the summary row is
//        UN-hidden and carries the receipt metadata (reclaim pct, weights,
//        kept count) — the cockpit's card paints from exactly these;
//    R3  the plain -p world: the summary row STAYS transcript-only (the SDK
//        output contract is untouched);
//    R4  the card renders the new facts and the boundary row speaks the
//        trigger + folded weight (structural).
//
//  Run:  ~/.bun/bin/bun run scripts/compact/prove-compact-receipt.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── hermetic env BEFORE any src import ──────────────────────────────────────
delete process.env.NODE_ENV
delete process.env.CI
for (const ambient of [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_SCRIPTED_STREAM',
  'MERCURY_SIMPLE',
  'MERCURY_MAX_OUTPUT_TOKENS',
  'MERCURY_HOME',
  'MERCURY_EFFORT_LEVEL',
  'MAX_THINKING_TOKENS',
  'GOOGLE_API_KEY',
  'MERCURY_CONCOURSE_WORKER',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'compact-receipt-'))
// The verbatim keep-tail rides the fold when enough rounds exist — explicit
// opt-in so the receipt's tail line is exercised deterministically.
process.env.MERCURY_COMPACT_KEEP_TAIL = '1'

const FIXTURE_PORT = 34115

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
  console.log('\nTIMEOUT — compact receipt prover exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { startCrossfamilyFixture } = await import('../lib/crossfamilyConcourseFixture.ts')
const fixture = await startCrossfamilyFixture({ port: FIXTURE_PORT })
Object.assign(process.env, fixture.env)

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { call } = await import('../../src/commands/compact/compact.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')

/** Ten user/assistant rounds so the verbatim keep-tail has a head to fold. */
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
        content: [{ type: 'text', text: `Adjusted module ${index} and its checks pass — details recorded.` }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 900 + index, output_tokens: 60 },
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
    denialTracking: undefined,
    tasks: {},
    mcp: { clients: [], tools: [], commands: [], resources: {} },
    effortValue: 'high',
    verbose: false,
    mainLoopModel: model,
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
      mainLoopModel: model,
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
  compactionResult?: {
    summaryMessages?: Array<{
      isVisibleInTranscriptOnly?: true
      summarizeMetadata?: { messagesSummarized?: number; contextReclaimedPct?: number; tokensBefore?: number; tokensAfter?: number; keptMessages?: number }
    }>
    messagesToKeep?: unknown[]
  }
}

// ---------------------------------------------------------------------------
section('R1+R2 the hosted seat — the receipt speaks and the card metadata lands')
process.env.MERCURY_CONCOURSE_WORKER = '1'
{
  const result = (await call('', makeCommandContext('claude-opus-4-8') as never)) as CompactCallResult
  const text = result.displayText ?? ''
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '')
  check('the command answered a compact result', result.type === 'compact')
  check('R1 the receipt names the folded count', /folded \d+ messages? into the summary/.test(plain), plain)
  check('R1 the receipt carries the weight arrow (before → after tokens)', /context \S+ → \S+ tokens/.test(plain), plain)
  check('R1 the receipt names the verbatim tail survival', /last \d+ messages? kept verbatim/.test(plain), plain)
  check('R1 the receipt names where the retained summary is readable', /reads the full summary — what the agent retains/.test(plain), plain)
  check('R1 the bare word alone is gone', plain.trim() !== 'Compacted', plain)

  const summaries = result.compactionResult?.summaryMessages ?? []
  const summary = summaries[0]
  check('R2 the summary row exists', summary !== undefined)
  check(
    'R2 hosted seat: the summary row is UN-hidden (the cockpit paints the card)',
    summary !== undefined && summary.isVisibleInTranscriptOnly !== true,
    JSON.stringify({ hidden: summary?.isVisibleInTranscriptOnly }),
  )
  const meta = summary?.summarizeMetadata
  check('R2 the card metadata carries the folded count', typeof meta?.messagesSummarized === 'number' && meta.messagesSummarized > 0, JSON.stringify(meta))
  check('R2 the card metadata carries the real reclaim pct', typeof meta?.contextReclaimedPct === 'number', JSON.stringify(meta))
  check(
    'R2 the card metadata carries the weights (before/after)',
    typeof meta?.tokensBefore === 'number' && typeof meta?.tokensAfter === 'number',
    JSON.stringify(meta),
  )
  const kept = result.compactionResult?.messagesToKeep?.length ?? 0
  check('R2 the verbatim tail rode the fold (kept > 0 — the fixture has ten rounds)', kept > 0, `kept=${kept}`)
  check('R2 the card metadata names the kept count', meta?.keptMessages === kept, JSON.stringify({ meta, kept }))
}

// ---------------------------------------------------------------------------
section('R3 the plain -p world — the transcript-only summary stands (SDK contract)')
delete process.env.MERCURY_CONCOURSE_WORKER
{
  const result = (await call('', makeCommandContext('claude-opus-4-8') as never)) as CompactCallResult
  const summary = (result.compactionResult?.summaryMessages ?? [])[0]
  check('the command answered a compact result', result.type === 'compact')
  check(
    'R3 plain headless: the summary row STAYS transcript-only',
    summary !== undefined && summary.isVisibleInTranscriptOnly === true,
    JSON.stringify({ hidden: summary?.isVisibleInTranscriptOnly }),
  )
  const plain = (result.displayText ?? '').replace(/\x1b\[[0-9;]*m/g, '')
  check('R3 …and the receipt line still speaks the numbers (scrollback truth)', /context \S+ → \S+ tokens/.test(plain), plain)
}

// ---------------------------------------------------------------------------
section('R4 the card and the boundary row (structural)')
{
  const read = (rel: string): string => readFileSync(join(import.meta.dir, '..', '..', rel), 'utf8')
  const card = read('src/components/MercuryCompactSummary.tsx')
  check('the card renders the weight arrow', card.includes('tokensBefore') && card.includes('tokensAfter'))
  check('the card renders the kept-verbatim line', card.includes('keptMessages') && card.includes('kept verbatim'))
  check('the card names what the summary IS (what the agent retains)', card.includes('what the agent retains'))
  const boundary = read('src/components/messages/CompactBoundaryMessage.tsx')
  check('the boundary row can speak the automatic trigger', boundary.includes('automatically'))
  check('the boundary row can speak the folded weight', boundary.includes('preTokens') && boundary.includes('folded'))
  const wire = read('src/components/Message.tsx')
  check('the render site hands the boundary its record', wire.includes('CompactBoundaryMessage message='))
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
