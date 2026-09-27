#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'live-counter-road-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
delete process.env.MERCURY_HOME

const { onSeatLine } = await import('../../src/daemon/sessionSeat.ts')
const { readSessionTail } = await import('../../src/services/engine-connector/seatProjections.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { compatSlotLaneProfile } = await import('../../src/services/providers/openaicompat/compatCallModel.ts')
const { streamCompatChat } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
const { toSDKStatusPayload } = await import('../../src/utils/messages/mappers.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const wordsModule = await import('../../src/components/Spinner/liveCounterWords.ts').catch(() => null)

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const dir = mkdtempSync(join(tmpdir(), 'live-counter-road-daemon-'))
const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-liveroad0001'
const SHORT = 'concourse-lcr1'
updateConcourseWorkers(workers => {
  workers[SHORT] = {
    schema: 1,
    runnerId: SHORT,
    sessionId: sid,
    workspaceId: 'ws-lcr',
    isolation: 'exclusive',
    modelKey: 'compat/fixture-reasoner',
    effort: 'high',
    spawnedAt: Date.now(),
    lastLiveAt: Date.now(),
    settingsSnapshot: { schema: 1, snapshotId: 's', sessionId: sid, profileRevision: 0, profileDigest: 'd', resolvedAt: Date.now(), rows: [] } as never,
    workspaceKind: 'plain-folder',
  } as never
}, dir)
const roster = { control: () => true, list: () => [], patchSeatModel: () => true }
const tail = () => readSessionTail(sid, dir)
const feed = (frame: Record<string, unknown>): void => onSeatLine(SHORT, JSON.stringify(frame), roster as never, dir)

const FIRST_BYTE_DELAY_MS = 3_000
const REASONING_MS = 2_000
const REASONING_ROWS = 10
const TEXT_ROWS = 5
const TEXT_GAP_MS = 150
const THOUGHT = 'weighing the harbour chart before answering; '
const PROSE = 'The tide turns at dusk. '

const sse = (payload: unknown): Uint8Array => new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`)
const chunkRow = (delta: Record<string, unknown>, finish: string | null = null) => ({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-reasoner', choices: [{ index: 0, delta, finish_reason: finish }] })

let fetchCalls = 0
const fixtureFetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
  fetchCalls++
  await sleep(FIRST_BYTE_DELAY_MS)
  const signal = init?.signal
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const gap = REASONING_MS / REASONING_ROWS
      for (let index = 0; index < REASONING_ROWS; index++) {
        if (signal?.aborted) return
        controller.enqueue(sse(chunkRow({ reasoning_content: THOUGHT })))
        await sleep(gap)
      }
      for (let index = 0; index < TEXT_ROWS; index++) {
        if (signal?.aborted) return
        controller.enqueue(sse(chunkRow({ content: PROSE })))
        await sleep(TEXT_GAP_MS)
      }
      controller.enqueue(sse(chunkRow({}, 'stop')))
      controller.enqueue(sse({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-reasoner', choices: [], usage: { prompt_tokens: 40, completion_tokens: 130 } }))
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}) as unknown as typeof fetch

const profile = {
  ...compatSlotLaneProfile,
  resolveCredential: () => ({}),
  requestUrl: () => 'http://127.0.0.1:1/v1/chat/completions',
  streamTransport(streamOptions: Record<string, unknown>) {
    return { events: streamCompatChat({ ...(streamOptions as never), fetchImpl: fixtureFetch } as never) }
  },
}

const waits: Array<Record<string, unknown> | null> = []
const gen = compatChatCallModel(profile as never, {
  messages: [createUserMessage({ content: 'Chart the tide for me' })] as never,
  systemPrompt: ['fixture system prompt'] as never,
  thinkingConfig: { type: 'enabled', budgetTokens: 1024 } as never,
  tools: [] as never,
  signal: new AbortController().signal,
  options: {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    model: 'compat/fixture-reasoner',
    isNonInteractiveSession: true,
    querySource: 'agent:builtin:test',
    agents: [],
    hasAppendSystemPrompt: false,
    mcpTools: [],
    onWait: (wait: unknown) => {
      waits.push(wait === null ? null : { ...(wait as Record<string, unknown>) })
      feed({ type: 'system', subtype: 'status', status: toSDKStatusPayload({ wait }) })
    },
  } as never,
})

const started = Date.now()
const errors: string[] = []
const consumed = (async () => {
  for await (const item of gen) {
    const m = item as { type?: string; event?: unknown; isApiErrorMessage?: boolean; message?: { content?: Array<{ text?: string }> } }
    if (m.type === 'stream_event') feed({ type: 'stream_event', event: m.event as Record<string, unknown> })
    else if (m.type === 'assistant' && m.isApiErrorMessage) errors.push(String(m.message?.content?.[0]?.text ?? ''))
    else if (m.type === 'assistant') feed({ type: 'assistant', message: (m as { message: unknown }).message as Record<string, unknown> })
  }
})()

type Facts = { replyChars: number; thinkingChars: number; wireOutputTokens: number | null; firstByteAtMs: number | null; wait: unknown }
const factsOfTail = (): Facts => {
  const t = tail()
  const turnChars = t?.turnChars ?? 0
  const thinking = (t as { turnThinkingChars?: number } | null)?.turnThinkingChars ?? 0
  return {
    replyChars: Math.max(0, turnChars - thinking),
    thinkingChars: thinking,
    wireOutputTokens: typeof t?.turnOutputTokens === 'number' ? t.turnOutputTokens : null,
    firstByteAtMs: typeof (t as { firstByteAtMs?: number } | null)?.firstByteAtMs === 'number' ? (t as { firstByteAtMs: number }).firstByteAtMs : null,
    wait: t?.wait ?? null,
  }
}
const rowWords = (facts: Facts, phase: 'thinking' | 'writing'): string => {
  if (wordsModule === null) return '(no words function)'
  const words = wordsModule.liveCounterWords({ ...(facts as never), phase, sentAtMs: started }, Date.now())
  return wordsModule.liveCounterSegments(words).join(' · ')
}

console.log('the compat road under a fixture server: first byte at 3 s, reasoning-only for 2 s, then text — the seat\'s live facts move at each stage')

await sleep(1_200)
const reading = factsOfTail()
const readingRow = rowWords(reading, 'thinking')
check('the request left: the seat carries the first-byte wait', (reading.wait as { kind?: string } | null)?.kind === 'first-byte', JSON.stringify(reading.wait))
check('no byte yet: the seat stamps no first-byte-at and counts nothing', reading.firstByteAtMs === null && reading.replyChars === 0 && reading.thinkingChars === 0, JSON.stringify(reading))
check('the words function has a home (the row\'s live words are owned in one place)', wordsModule !== null)
check(`the row reads the prompt with the clock and the promise, never a dead 0 (${readingRow})`, /^reading the prompt · \d+s · first byte expected within /.test(readingRow) && !readingRow.includes('↓ 0'), readingRow)

await sleep(FIRST_BYTE_DELAY_MS - 1_200 + 700)
const thinkingA = factsOfTail()
check('the first byte landed: the wait cleared and the seat stamped first-byte-at', thinkingA.wait === null && thinkingA.firstByteAtMs !== null && thinkingA.firstByteAtMs >= started + FIRST_BYTE_DELAY_MS - 50, JSON.stringify(thinkingA))
check('reasoning rows stream: the seat counts thinking characters apart from the reply', thinkingA.thinkingChars > 0 && thinkingA.replyChars === 0, JSON.stringify(thinkingA))
await sleep(800)
const thinkingB = factsOfTail()
check('the thinking count grows while the reasoning stretch runs', thinkingB.thinkingChars > thinkingA.thinkingChars && thinkingB.replyChars === 0, `${thinkingA.thinkingChars} → ${thinkingB.thinkingChars}`)
const thinkingRow = rowWords(thinkingB, 'thinking')
check(`the row counts the thinking tokens beside the clock (${thinkingRow})`, /^↓ ~\d+ thinking tokens · thinking · \d+s$/.test(thinkingRow), thinkingRow)

await sleep(REASONING_MS - 1_500 + 250)
const replyA = factsOfTail()
check('text rows stream: the reply count starts moving while the thinking count stands complete', replyA.replyChars > 0 && replyA.thinkingChars === REASONING_ROWS * THOUGHT.length, JSON.stringify(replyA))
await sleep(TEXT_GAP_MS * 2 + 50)
const replyB = factsOfTail()
check('the reply count grows row by row', replyB.replyChars > replyA.replyChars, `${replyA.replyChars} → ${replyB.replyChars}`)
const replyRow = rowWords(replyB, 'writing')
check(`the row shows thinking and reply counts together (${replyRow})`, /^↓ ~\d+ thinking · \d+ tokens · writing · \d+s$/.test(replyRow), replyRow)

await Promise.race([consumed, sleep(4_000)])
await sleep(120)
const settled = factsOfTail()
check('one fixture request carried the whole turn', fetchCalls === 1 && errors.length === 0, `${fetchCalls} fetch · ${JSON.stringify(errors)}`)
check('at the end every thinking character and every reply character is counted once', settled.thinkingChars === REASONING_ROWS * THOUGHT.length && settled.replyChars === TEXT_ROWS * PROSE.length, JSON.stringify(settled))
feed({ type: 'result', subtype: 'success' })
const after = factsOfTail()
check('the turn\'s result retires the thinking count and the first-byte stamp with the rest', after.thinkingChars === 0 && after.replyChars === 0 && after.firstByteAtMs === null, JSON.stringify(after))
check('the road published the wait once at the send and cleared it once at the first byte', waits.length === 2 && (waits[0] as { kind?: string })?.kind === 'first-byte' && waits[1] === null, JSON.stringify(waits))

console.log(failures === 0 ? '\n✅ live counter on the compat road GREEN' : `\n❌ live counter on the compat road RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
