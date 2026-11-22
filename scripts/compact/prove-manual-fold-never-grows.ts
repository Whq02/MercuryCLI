#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const ambient of [
  'MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE',
  'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_HOME', 'MERCURY_EFFORT_LEVEL', 'MERCURY_THINKING_BUDGET', 'GOOGLE_API_KEY', 'MERCURY_CONCOURSE_WORKER',
]) {
  delete process.env[ambient]
}
const scratch = mkdtempSync(join(tmpdir(), 'manual-fold-never-grows-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_COMPACT_KEEP_TAIL = '1'
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${!cond && hint ? ` — change: ${hint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — prove-manual-fold-never-grows exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

const { startCrossfamilyFixture } = await import('../lib/crossfamilyConcourseFixture.ts')
const fixture = await startCrossfamilyFixture({ port: 0 })
Object.assign(process.env, fixture.env)

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { call } = await import('../../src/commands/compact/compact.ts')
const { compactConversation, buildPostCompactMessages, projectManualFold } = await import('../../src/services/compact/compact.ts')
const { estimateContextTokens } = await import('../../src/services/compact/microCompact.ts')
const { requestGaugeDigest } = await import('../../src/services/run/requestGauge.ts')
const { createUserMessage } = await import('../../src/services/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')

const MODEL = 'claude-opus-4-8'
type AnyMsg = Record<string, unknown> & { type?: string }
type CompactCallResult = { type: string; displayText?: string; compactionResult: Parameters<typeof buildPostCompactMessages>[0] }

let seq = 0
const uid = (): string => `00000000-0000-4000-a000-${String(++seq).padStart(12, '0')}`
const summaryRequests = (): number => fixture.captured.filter(hit => hit.lane.startsWith('anthropic')).length
const plainOf = (result: CompactCallResult): string => (result.displayText ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0] ?? ''

function makeContext(messages: AnyMsg[], reads: InstanceType<typeof FileStateCache>): Record<string, unknown> {
  const appState = {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' as const },
    sessionHooks: new Map(),
    tasks: {},
    mcp: { clients: [], tools: [], commands: [], resources: {} },
    effortValue: 'high',
    verbose: false,
    engineModel: MODEL,
  }
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages,
    agentType: undefined,
    agentId: undefined,
    readFileState: reads,
    options: {
      tools: [],
      mcpClients: [],
      commands: [],
      engineModel: MODEL,
      maxThinkingTokens: 0,
      thinkingConfig: { type: 'disabled' as const },
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [] },
    },
  }
}

const partialFiles: string[] = []
for (let i = 0; i < 4; i++) {
  const filePath = join(scratch, `module-${i}.js`)
  const full = Array.from({ length: 400 }, (_, line) => `export function fn_${i}_${line}(x) { return x + ${line} * 12345; }`).join('\n') + '\n'
  writeFileSync(filePath, full)
  partialFiles.push(filePath)
}

function buildPartialReadSession(): { messages: AnyMsg[]; reads: InstanceType<typeof FileStateCache> } {
  const messages: AnyMsg[] = []
  const reads = new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024)
  for (let i = 0; i < 8; i++) {
    messages.push(createUserMessage({ content: `Early ask ${i}: inspect module-${i % 4}.js` }) as AnyMsg)
    messages.push({
      type: 'assistant',
      uuid: uid(),
      requestId: `req_e_${i}`,
      message: {
        id: `msg_e_${i}`,
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [{ type: 'text', text: `Inspected module-${i % 4}.js. ${'detail '.repeat(400)}` }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10_000 + i * 800, output_tokens: 200 },
      },
    })
  }
  partialFiles.forEach((filePath, i) => {
    reads.set(filePath, { content: `export const tail = ${i}\n`, timestamp: 100 + i, offset: 390, limit: 10 })
  })
  for (let i = 0; i < 10; i++) {
    messages.push(createUserMessage({ content: `Recent ask ${i}` }) as AnyMsg)
    const body = i === 2 ? 'SESSIONS DOCS CONTENT LINE '.repeat(4_000) : 'Recent reply text. '.repeat(20)
    messages.push({
      type: 'assistant',
      uuid: uid(),
      requestId: `req_r_${i}`,
      message: {
        id: `msg_r_${i}`,
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [{ type: 'text', text: body }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 57_000, output_tokens: 600 },
      },
    })
  }
  return { messages, reads }
}

section('1 restored files would make the fold grow: projection counts disk size, drops restored files, and lands smaller')
{
  const { messages, reads } = buildPartialReadSession()
  const beforeTokens = estimateContextTokens(messages as never, MODEL)
  const ctx = makeContext(messages, reads)
  const projection = await projectManualFold(
    messages as never,
    ctx as never,
    { systemPrompt: [], userContext: {}, systemContext: {}, toolUseContext: ctx, forkContextMessages: messages } as never,
    900_000,
  )
  check(
    'projection detects that restoring files would grow the fold and chooses restoreFiles=false',
    projection !== null && projection.restoreFiles === false && projection.after < projection.before,
    JSON.stringify(projection),
    'projectManualFold in src/services/compact/compact/projection.ts and createPostCompactFileAttachments in src/services/compact/compact/attachments.ts must count real disk-restored file sizes and retry without files when restoring files would not shrink',
  )
  const reqsBefore = summaryRequests()
  const result = (await call('', ctx as never)) as CompactCallResult
  const post = buildPostCompactMessages(result.compactionResult)
  const afterTokens = estimateContextTokens(post as never, MODEL)
  const restoredFileCount = result.compactionResult.attachments.filter(a => a.attachment.type === 'file' || a.attachment.type === 'compact_file_reference').length
  check(
    'the manual fold runs once and drops restored files so context strictly shrinks',
    summaryRequests() === reqsBefore + 1 && restoredFileCount === 0 && afterTokens < beforeTokens && (result.compactionResult.truePostCompactTokenCount ?? Infinity) < result.compactionResult.preCompactTokenCount,
    `before=${beforeTokens} after=${afterTokens} receipt=${plainOf(result)} restoredFiles=${restoredFileCount}`,
    'call in src/commands/compact/compact.ts and compactConversation in src/services/compact/compact.ts must pass restoreFiles=false from projectManualFold and omit file attachments when they would grow the fold',
  )
}

section('2 Windows SUBMIT 352 shape (RequestGauge + high-effort thinking + large recent read + restored files): refuses before any model call')
{
  const messages: AnyMsg[] = []
  const reads = new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024)
  const f1 = join(scratch, 'pricing.js')
  const f2 = join(scratch, 'pricing.test.js')
  const f1Content = Array.from({ length: 120 }, (_, i) => `export function price_${i}(a, b) { return Math.round((a * b) * 100) / 100 }`).join('\n') + '\n'
  const f2Content = Array.from({ length: 120 }, (_, i) => `test('price_${i}', () => assert.equal(price_${i}(1, 2), 2))`).join('\n') + '\n'
  writeFileSync(f1, f1Content)
  writeFileSync(f2, f2Content)
  reads.set(f1, { content: f1Content, timestamp: 100, offset: 0, limit: undefined })
  reads.set(f2, { content: f2Content, timestamp: 101, offset: 0, limit: undefined })
  for (let i = 0; i < 6; i++) {
    messages.push(createUserMessage({ content: `Early ask ${i}: work on pricing and tests` }) as AnyMsg)
    messages.push({
      type: 'assistant',
      uuid: uid(),
      requestId: `req_w_e_${i}`,
      message: {
        id: `msg_w_e_${i}`,
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [
          { type: 'thinking', thinking: 'thinking deeply about pricing and format and tests '.repeat(120), signature: 'sig' },
          { type: 'text', text: `Done with early step ${i}. ${'work output '.repeat(120)}` },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 20_000 + i * 500, output_tokens: 400 },
      },
    })
  }
  for (let i = 0; i < 10; i++) {
    messages.push(createUserMessage({ content: `Recent ask ${i}` }) as AnyMsg)
    const isLast = i === 9
    const body = i === 2 ? 'SESSIONS DOCS CONTENT LINE '.repeat(4_500) : `Recent reply ${i}. ${'note '.repeat(40)}`
    const prefixDigest = isLast ? requestGaugeDigest(messages as never) : undefined
    messages.push({
      type: 'assistant',
      uuid: uid(),
      requestId: `req_w_r_${i}`,
      message: {
        id: `msg_w_r_${i}`,
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [
          { type: 'thinking', thinking: 'recent high effort thinking '.repeat(200), signature: 'sig' },
          { type: 'text', text: body },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 57_000, output_tokens: 600 },
      },
      ...(isLast ? {
        contextGauge: {
          version: 1,
          key: `anthropic:${MODEL}:c1000000`,
          epoch: 1,
          digest: prefixDigest!,
          rawTokens: 42_000,
          fixed: { digest: 'f', tokens: 24_000 },
          density: { ratio: 1.25, samples: 8, residuals: [500] },
          sample: { eligible: true, denominator: 2_000, measured: 2_500, reason: 'matched-request-tail' },
        },
      } : {}),
    })
  }
  const ctx = makeContext(messages, reads)
  const reqsBefore = summaryRequests()
  let threw: string | undefined
  let result: CompactCallResult | undefined
  try {
    result = (await call('', ctx as never)) as CompactCallResult
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  check(
    'refuses before calling the summariser when even without restored files the fold would not shrink below 57.6k',
    result === undefined && threw !== undefined && summaryRequests() === reqsBefore,
    `threw=${threw ?? 'none'} result=${result ? plainOf(result) : 'none'} reqs=${summaryRequests() - reqsBefore}`,
    'createFoldMeter in src/services/compact/compact/foldMeasure.ts must count before with thinking stripped, by the one estimate projectManualFold in src/services/compact/compact/projection.ts counts the fold with, so a fold that would not land smaller is refused before the summariser',
  )
}

section('3 post-summary growth guard: when the summariser returns an oversized summary, the manual fold aborts and keeps the original context')
{
  const giantSummary = `<summary>\n${'1. Detailed summary section repeating verbatim context and code snippets. '.repeat(900)}\n</summary>`
  const giantServer = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`
      res.end([
        `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_giant', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } })}`,
        `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: giantSummary } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
        `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 100, output_tokens: 16_000 } })}`,
        `event: message_stop\n${sse({ type: 'message_stop' })}`,
      ].join(''))
    })
  })
  await new Promise<void>(resolve => giantServer.listen(0, '127.0.0.1', () => resolve()))
  const addr = giantServer.address() as { port: number }
  const prevBaseUrl = process.env.ANTHROPIC_BASE_URL
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${addr.port}`
  try {
    const messages: AnyMsg[] = []
    const reads = new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024)
    reads.set(partialFiles[0]!, { content: 'keep-me\n', timestamp: 50, offset: 0, limit: undefined })
    for (let i = 0; i < 16; i++) {
      messages.push(createUserMessage({ content: `Turn ${i}: adjust module ${i}` }) as AnyMsg)
      messages.push({
        type: 'assistant',
        uuid: uid(),
        requestId: `req_g_${i}`,
        message: {
          id: `msg_g_${i}`,
          type: 'message',
          role: 'assistant',
          model: MODEL,
          content: [{ type: 'text', text: `Adjusted module ${i}. ${'working details '.repeat(140)}` }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 18_000, output_tokens: 200 },
        },
      })
    }
    const readSnapshot = JSON.stringify([...reads.entries()])
    const ctx = makeContext(messages, reads)
    let threw: string | undefined
    let result: CompactCallResult | undefined
    try {
      result = (await call('', ctx as never)) as CompactCallResult
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    check(
      'aborts instead of committing a fold whose real summary grew the context',
      result === undefined && threw !== undefined,
      `threw=${threw ?? 'none'} result=${result ? plainOf(result) : 'none'}`,
      'compactConversation in src/services/compact/compact.ts must refuse when recompactionInfo.mustShrink is true and the real measured post-compact context is not smaller than meter.before',
    )
    check(
      'restores readFileState intact when aborting after the summariser',
      JSON.stringify([...reads.entries()]) === readSnapshot,
      `keys=${[...reads.keys()].join(',')} size=${reads.size}`,
      'compactConversation in src/services/compact/compact.ts must restore context.readFileState from ledgerBeforeFold before throwing on a post-summary growth abort',
    )
  } finally {
    process.env.ANTHROPIC_BASE_URL = prevBaseUrl
    await new Promise<void>(resolve => giantServer.close(() => resolve()))
  }
}

section('4 automatic fold drops restored files when they would push the landed context above before')
{
  const { messages, reads } = buildPartialReadSession()
  const beforeTokens = estimateContextTokens(messages as never, MODEL)
  const ctx = makeContext(messages, reads)
  const result = await compactConversation(
    messages as never,
    ctx as never,
    { systemPrompt: [], userContext: {}, systemContext: {}, toolUseContext: ctx, forkContextMessages: messages } as never,
    true,
    undefined,
    true,
    { isRecompaction: false, turnsSincePreviousCompact: -1, autoCompactThreshold: 900_000 },
  )
  const afterTokens = result.truePostCompactTokenCount ?? estimateContextTokens(buildPostCompactMessages(result), MODEL)
  const restoredFileCount = result.attachments.filter(a => a.attachment.type === 'file' || a.attachment.type === 'compact_file_reference').length
  check(
    'automatic fold drops restored files so it does not land larger than before',
    afterTokens < beforeTokens && restoredFileCount === 0,
    `before=${beforeTokens} after=${afterTokens} restoredFiles=${restoredFileCount}`,
    'landFold in src/services/compact/compact/foldLanding.ts must drop restored file attachments when truePostCompactTokenCount >= before',
  )
}

await fixture.close()
clearTimeout(guard)
console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log(failures === 0 ? ' ✅ MANUAL FOLD NEVER GROWS GREEN' : ` ❌ ${failures} MANUAL FOLD NEVER GROWS FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
