#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'paints-once-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const pin of ['MERCURY_CRITTER_IDLE', 'MERCURY_CRITTER_GAZE', 'MERCURY_CRITTER_SLEEP', 'MERCURY_LIVE_CLOCK', 'MERCURY_LIVE_GLYPHS']) {
  process.env[pin] = '0'
}
process.env.MERCURY_FORCE_SYNC_OUTPUT = '1'
process.env.FORCE_COLOR = '3'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { streamRenderedMessages } = await import('../../src/utils/exportRenderer.tsx')
const { NO_RESPONSE_REQUESTED, INTERRUPT_MESSAGE, INTERRUPT_MESSAGE_FOR_TOOL_USE } = await import('../../src/utils/messages.ts')
const { startsWithApiErrorPrefix } = await import('../../src/services/api/errors.ts')
const { loadAllLogsFromSessionFile } = await import('../../src/utils/sessionStorage/logs.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

const COLUMNS = 400
async function paint(messages: unknown[]): Promise<string> {
  const chunks: string[] = []
  await streamRenderedMessages(
    messages as never,
    [] as never,
    chunk => {
      chunks.push(chunk)
    },
    { columns: COLUMNS, verbose: true, chunkSize: 100_000 },
  )
  return chunks.join('')
}

const wordsOf = (s: string): string[] => s.match(/[A-Za-z0-9]{3,}/g) ?? []
const countRun = (hayWords: string, run: string): number => ` ${hayWords} `.split(` ${run} `).length - 1
function needleFor(text: string, all: readonly string[]): { run: string; expected: number } | null {
  const w = wordsOf(text)
  const n = Math.min(6, w.length)
  if (n === 0) return null
  const haystacks = all.map(t => wordsOf(t).join(' '))
  const hits = (run: string): number => haystacks.reduce((acc, h) => acc + countRun(h, run), 0)
  for (let i = 0; i + n <= w.length; i++) {
    const run = w.slice(i, i + n).join(' ')
    if (hits(run) === 1) return { run, expected: 1 }
  }
  const run = w.slice(0, n).join(' ')
  return { run, expected: hits(run) }
}
const isProse = (text: string): boolean =>
  text.trim() !== '' &&
  text !== NO_RESPONSE_REQUESTED &&
  text !== INTERRUPT_MESSAGE &&
  text !== INTERRUPT_MESSAGE_FOR_TOOL_USE &&
  !startsWithApiErrorPrefix(text)

type Tally = { index: number; length: number; expected: number; painted: number }
function tally(frame: string, texts: readonly string[]): { rows: Tally[]; unmeasured: number } {
  const hay = wordsOf(stripAnsi(frame)).join(' ')
  const rows: Tally[] = []
  let unmeasured = 0
  texts.forEach((text, index) => {
    const needle = needleFor(text, texts)
    if (!needle) {
      unmeasured++
      return
    }
    rows.push({ index, length: text.length, expected: needle.expected, painted: countRun(hay, needle.run) })
  })
  return { rows, unmeasured }
}

const uuidAt = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const stampAt = (n: number): string => `2026-06-19T12:00:${String(n).padStart(2, '0')}.000Z`
const usage = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: null,
  inference_geo: null,
  iterations: null,
  output_tokens_details: null,
  server_tool_use: null,
  service_tier: null,
  speed: null,
}
const assistantRow = (n: number, content: unknown[], stop: 'tool_use' | 'end_turn'): Record<string, unknown> => ({
  type: 'assistant',
  uuid: uuidAt(n),
  timestamp: stampAt(n),
  requestId: undefined,
  message: {
    id: `msg_fixture_${n}`,
    type: 'message',
    role: 'assistant',
    model: 'fixture-model',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage,
  },
})
const userRow = (n: number, content: unknown): Record<string, unknown> => ({
  type: 'user',
  uuid: uuidAt(n),
  timestamp: stampAt(n),
  message: { role: 'user', content },
})
const NOTE = 'Reading the sum table before the arithmetic tool runs on it.'
const FINAL = 'The two numbers add to four and the table already listed that total.'
const turn = (note: Record<string, unknown>): unknown[] => [
  userRow(1, 'add the two numbers'),
  assistantRow(2, [note], 'tool_use'),
  assistantRow(3, [{ type: 'tool_use', id: 'call_fixture_1', name: 'EchoTool', input: { text: 'four' } }], 'tool_use'),
  userRow(4, [{ type: 'tool_result', tool_use_id: 'call_fixture_1', content: 'four' }]),
  assistantRow(5, [{ type: 'text', text: FINAL, citations: null }], 'end_turn'),
]
const rowsWith = (frame: string, words: string): string[] =>
  frame.split('\n').filter(line => wordsOf(stripAnsi(line)).join(' ').includes(words))

section('§1 the synthetic turn — a note, a call, a result, the answer: two texts, each painted once')
{
  const plainFrame = await paint(turn({ type: 'text', text: NOTE, citations: null }))
  const plain = tally(plainFrame, [NOTE, FINAL])
  check('the frame is not empty (the painter mounted)', stripAnsi(plainFrame).trim() !== '')
  check('both texts were measurable (a word run each)', plain.rows.length === 2 && plain.unmeasured === 0)
  check('the working note paints exactly once', plain.rows[0]?.painted === 1, JSON.stringify(plain.rows[0]))
  check('the final answer paints exactly once', plain.rows[1]?.painted === 1, JSON.stringify(plain.rows[1]))

  const labelledFrame = await paint(turn({ type: 'text', text: NOTE, citations: null, phase: 'commentary' }))
  const labelled = tally(labelledFrame, [NOTE, FINAL])
  check('a note labelled commentary still paints exactly once (never collapsed, never suppressed)', labelled.rows[0]?.painted === 1, JSON.stringify(labelled.rows[0]))
  check('…and the final answer beside it paints exactly once', labelled.rows[1]?.painted === 1, JSON.stringify(labelled.rows[1]))
  check('the labelled frame carries the SAME words and layout as the unlabelled one', stripAnsi(labelledFrame) === stripAnsi(plainFrame))
  check('…in a DIFFERENT ink (the frames differ only in their escapes)', labelledFrame !== plainFrame)
  const noteWords = wordsOf(NOTE).slice(0, 3).join(' ')
  const finalWords = wordsOf(FINAL).slice(0, 3).join(' ')
  check(
    'the ink change sits on the note’s row, not the answer’s',
    rowsWith(labelledFrame, noteWords).join('\n') !== rowsWith(plainFrame, noteWords).join('\n') &&
      rowsWith(labelledFrame, finalWords).join('\n') === rowsWith(plainFrame, finalWords).join('\n'),
  )
  const finalLabelledFrame = await paint(turn({ type: 'text', text: NOTE, citations: null, phase: 'final_answer' }))
  check('a block labelled final_answer paints byte-identically to an unlabelled one (the primary ink)', finalLabelledFrame === plainFrame)
}

section('§2 a recorded transcript — every prose text block paints exactly once')
{
  const copy = process.env.MERCURY_PROVE_TRANSCRIPT_COPY
  if (!copy) {
    console.log('  [SKIP] MERCURY_PROVE_TRANSCRIPT_COPY is unset — the recorded transcript is private; run this leg with a copy of it')
  } else if (!existsSync(copy)) {
    check('the named transcript copy exists', false, copy)
  } else {
    const records = readFileSync(copy, 'utf8')
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as { payload?: { kind?: string; content?: Array<{ kind?: string }> } })
    const rawTextBlocks = records
      .filter(r => r.payload?.kind === 'output')
      .reduce((n, r) => n + (r.payload?.content ?? []).filter(b => b.kind === 'text').length, 0)
    const logs = await loadAllLogsFromSessionFile(copy)
    const longest = logs.reduce<(typeof logs)[number] | undefined>((best, log) => (log.messages.length > (best?.messages.length ?? -1) ? log : best), undefined)
    check('the transcript resumes to a conversation', longest !== undefined && longest.messages.length > 0, `${logs.length} leaf conversation(s)`)
    if (longest) {
      const texts: string[] = []
      let skipped = 0
      for (const m of longest.messages as Array<{ type: string; message?: { content?: unknown } }>) {
        if (m.type !== 'assistant' || !Array.isArray(m.message?.content)) continue
        for (const b of m.message.content as Array<{ type?: string; text?: unknown }>) {
          if (b.type !== 'text' || typeof b.text !== 'string') continue
          if (isProse(b.text)) texts.push(b.text)
          else skipped++
        }
      }
      const frame = await paint(longest.messages as unknown[])
      const { rows, unmeasured } = tally(frame, texts)
      const painted = rows.reduce((n, r) => n + r.painted, 0)
      const expected = rows.reduce((n, r) => n + r.expected, 0)
      console.log(`  raw records: ${records.length} · text blocks in the record: ${rawTextBlocks} · prose text blocks in the resumed conversation: ${texts.length} (non-prose skipped: ${skipped}, unmeasurable: ${unmeasured}) · painted rows: ${painted}`)
      const off = rows.filter(r => r.painted !== r.expected)
      check('every prose text block paints exactly as many times as it was emitted', off.length === 0, off.map(r => `block ${r.index} (${r.length} chars): expected ${r.expected}, painted ${r.painted}`).join('; '))
      check('text-block count equals painted-row count', painted === expected && rows.length + unmeasured === texts.length, `${painted} painted vs ${expected} expected`)
    }
  }
}

console.log(failures === 0 ? '\nprove-text-emission-paints-once: ALL LAWS HOLD' : `\nprove-text-emission-paints-once: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
