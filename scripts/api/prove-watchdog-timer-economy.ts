#!/usr/bin/env bun
// ============================================================================
//  scripts/api/prove-watchdog-timer-economy.ts — the stream idle watchdog's
//  timer traffic is INDEPENDENT of the event count.
//
//  The previous shape cleared and recreated TWO setTimeouts on every SSE
//  event (a counted 2 creates + up to 2 clears per event, read directly from
//  the old resetStreamIdleTimer: clearStreamIdleTimers() then two setTimeout
//  calls, re-invoked at the top of the for-await loop) — thousands of timer
//  ops over a long reply. The lazy single-deadline watchdog does ONE
//  timestamp write per event and re-aims one timer only when a deadline
//  could actually have passed.
//
//  Instrument: globalThis.setTimeout is wrapped BEFORE any src import; the
//  watchdog's creations are attributable by callback name
//  (onStreamIdleDeadline — a named function precisely so this prover can
//  attribute without text-scraping). Two drives (few events, many events)
//  pin the slope: the watchdog's timer creations must NOT grow with events.
//
//  Run: ~/.bun/bin/bun run scripts/api/prove-watchdog-timer-economy.ts
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// ── the timer instrument (installed before ANY src import) ─────────────────
let watchdogTimerCreates = 0
let totalTimerCreates = 0
let counting = false
const realSetTimeout = globalThis.setTimeout
const countingSetTimeout = ((
  cb: (...cbArgs: unknown[]) => void,
  ms?: number,
  ...rest: unknown[]
) => {
  if (counting) {
    totalTimerCreates++
    if (typeof cb === 'function' && cb.name === 'onStreamIdleDeadline') {
      watchdogTimerCreates++
    }
  }
  return realSetTimeout(cb as never, ms as never, ...(rest as never[]))
}) as typeof globalThis.setTimeout
countingSetTimeout.__promisify__ = realSetTimeout.__promisify__
globalThis.setTimeout = countingSetTimeout

delete process.env.NODE_ENV
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'watchdog-economy-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
// A budget far past the drive's wall time: the watchdog never fires during
// a healthy stream, so its ONLY creations are the arm + deadline re-aims —
// a count independent of how many events flow.
process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '30000'
process.env.MERCURY_MAX_RETRIES = '1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const streamWithDeltas = (deltaCount: number): string => {
  const parts: string[] = [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
  ]
  for (let i = 0; i < deltaCount; i++) {
    parts.push(
      `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `w${i} ` } })}`,
    )
  }
  parts.push(
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  )
  return parts.join('')
}

let deltasToServe = 5
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method !== 'POST' || !path.endsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(streamWithDeltas(deltasToServe))
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
const base = `http://127.0.0.1:${port}`
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: base,
  ANTHROPIC_AUTH_TOKEN: 'fixture-token',
})

console.log('============================================================')
console.log(' watchdog timer economy — creations independent of events')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')

async function drive(deltas: number): Promise<{ events: number; watchdog: number; total: number }> {
  deltasToServe = deltas
  watchdogTimerCreates = 0
  totalTimerCreates = 0
  counting = true
  let events = 0
  for await (const item of routedCallModel({
    messages: [createUserMessage({ content: 'go' })] as never,
    systemPrompt: ['fixture'] as never,
    thinkingConfig: { type: 'disabled' } as never,
    tools: [] as never,
    signal: new AbortController().signal,
    options: {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      model: 'claude-sonnet-5',
      isNonInteractiveSession: true,
      querySource: 'agent:builtin:test',
      agents: [],
      hasAppendSystemPrompt: false,
      mcpTools: [],
      effortValue: 'high',
    } as never,
  })) {
    if ((item as { type?: string }).type === 'stream_event') events++
  }
  counting = false
  return { events, watchdog: watchdogTimerCreates, total: totalTimerCreates }
}

section('two drives — the watchdog timer count must not scale with events')
{
  const small = await drive(5)
  const large = await drive(405)
  check('the small drive consumed its stream', small.events >= 5, `events=${small.events}`)
  check('the large drive consumed ~400 more events', large.events - small.events >= 380, `small=${small.events} large=${large.events}`)
  const slopeDetail = `watchdog creates: small=${small.watchdog} large=${large.watchdog}; total setTimeout creates: small=${small.total} large=${large.total}`
  console.log(`  · ${slopeDetail}`)
  check(
    'watchdog timer creations are event-count independent (delta ≤ 2 across +400 events; the old shape added 2 per event ⇒ ~800)',
    large.watchdog - small.watchdog <= 2,
    slopeDetail,
  )
  check(
    'the watchdog armed at all (attribution is live, not vacuous)',
    small.watchdog >= 1 && large.watchdog >= 1,
    slopeDetail,
  )
  check(
    'whole-process timer creations do not scale per event either (delta < 100 across +400 events)',
    large.total - small.total < 100,
    slopeDetail,
  )
}

globalThis.setTimeout = realSetTimeout
server.close()
console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
