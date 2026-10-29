#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'sio-laws-'))

const { StructuredIO } = await import('../../src/cli/structuredIO.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — structuredIO laws exceeded 60s')
  process.exit(1)
}, 60_000)
guard.unref?.()


function makeInput(): {
  iterable: AsyncIterable<string>
  push: (block: string) => void
  end: () => void
} {
  const queue: string[] = []
  let done = false
  let wake: (() => void) | null = null
  return {
    push: b => {
      queue.push(b)
      wake?.()
    },
    end: () => {
      done = true
      wake?.()
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length > 0) yield queue.shift()!
          if (done) return
          await new Promise<void>(r => {
            wake = r
          })
          wake = null
        }
      },
    },
  }
}

type Harness = {
  io: InstanceType<typeof StructuredIO>
  push: (o: unknown) => void
  pushRaw: (raw: string) => void
  end: () => void
  received: Array<Record<string, unknown>>
  refused: string[]
  outbound: Array<Record<string, unknown>>
  settle: () => Promise<void>
}

function makeHarness(): Harness {
  const input = makeInput()
  const refused: string[] = []
  const io = new StructuredIO(input.iterable, text => refused.push(text))
  const received: Array<Record<string, unknown>> = []
  const outbound: Array<Record<string, unknown>> = []
  void (async () => {
    for await (const m of io.structuredInput) {
      received.push(m as Record<string, unknown>)
    }
  })()
  void (async () => {
    for await (const m of io.outbound) {
      outbound.push(m as Record<string, unknown>)
    }
  })()
  return {
    io,
    push: o => input.push(JSON.stringify(o) + '\n'),
    pushRaw: raw => input.push(raw),
    end: () => input.end(),
    received,
    refused,
    outbound,
    settle: () => new Promise(r => setTimeout(r, 40)),
  }
}

console.log('============================================================')
console.log(' StructuredIO — the row stream\'s framing laws')
console.log('============================================================')

section('S1/S2 — line framing across blocks · prepend ordering · trailing line')
{
  const h = makeHarness()
  h.io.prependUserMessage('prepended first')
  const userMsg = (text: string) => JSON.stringify({ type: 'prompt', content: text })
  const whole = userMsg('split across blocks')
  h.pushRaw(whole.slice(0, 25))
  await h.settle()
  check('a partial line does NOT yield early', h.received.filter(m => m.type === 'prompt').length <= 1)
  h.pushRaw(whole.slice(25) + '\n\n')
  await h.settle()
  const users = () => h.received.filter(m => m.type === 'prompt').map(m => j(m))
  check('the PREPENDED message yielded FIRST', users()[0]?.includes('prepended first') === true, j(users()))
  check('the split message reassembled exactly once', users().filter(u => u.includes('split across blocks')).length === 1, j(users()))
  h.io.prependUserMessage('prepended mid-stream')
  h.push({ type: 'prompt', content: 'after mid-prepend' })
  await h.settle()
  const u = users()
  check('a mid-stream prepend lands before the next input message', u.indexOf(u.find(x => x.includes('prepended mid-stream'))!) < u.indexOf(u.find(x => x.includes('after mid-prepend'))!), j(u))
  h.pushRaw(userMsg('trailing no newline'))
  h.end()
  await h.settle()
  check('the final unterminated line still processes', users().some(x => x.includes('trailing no newline')), j(users()))
}

section('S3 — an undeclared type, an empty prompt and an empty shell row are each refused with one notice and skipped; the stream flows on')
{
  const h = makeHarness()
  delete process.env.SIO_LAW_PROBE
  h.push({ type: 'undeclared_probe' })
  h.push({ type: 'environment_probe', variables: { SIO_LAW_PROBE: 'applied' } })
  h.push({ type: 'user', message: { role: 'user', content: 'the old shape' } })
  h.push({ type: 'control_request', request_id: 'r1', request: { subtype: 'interrupt' } })
  h.push({ type: 'prompt', content: '' })
  h.push({ type: 'shell', command: '   ' })
  h.push({ type: 'prompt', content: 'after the refused lines' })
  h.push({ type: 'shell', command: 'echo ok' })
  h.push({ type: 'note', to: 'a1', content: 'for the agent' })
  await h.settle()
  check('no undeclared type reaches the consumer', !h.received.some(m => !['prompt', 'shell', 'note'].includes(String(m.type))), j(h.received.map(m => m.type)))
  check('a frame carrying environment variables leaves process.env untouched', process.env.SIO_LAW_PROBE === undefined)
  check('each refused line is refused once, in order, naming its type or its emptiness', h.refused.length === 6 && h.refused[0]!.includes("unknown row type 'undeclared_probe'") && h.refused[2]!.includes("unknown row type 'user'") && h.refused[3]!.includes("unknown row type 'control_request'") && h.refused[4]!.includes('no content') && h.refused[5]!.includes('no command'), j(h.refused))
  check('the stream keeps flowing past the refused lines: the prompt, the shell and the note rows arrive in order', j(h.received.map(m => m.type)) === j(['prompt', 'shell', 'note']), j(h.received))
  delete process.env.SIO_LAW_PROBE
  h.end()
}

section('S4 — a line longer than the reader\'s bound is refused and the reader resyncs at the next newline')
{
  const { MAX_LINE_BYTES } = await import('../../src/runner/wire/errors.ts')
  const h = makeHarness()
  const half = 'x'.repeat(Math.ceil(MAX_LINE_BYTES / 2) + 16)
  h.pushRaw(`{"type":"prompt","content":"${half}`)
  h.pushRaw(half)
  await h.settle()
  check('the over-long line is refused before its newline arrives', h.refused.length === 1 && h.refused[0]!.includes('longer than'), j(h.refused))
  h.pushRaw('"}\n')
  h.push({ type: 'prompt', content: 'after the long line' })
  await h.settle()
  check('the rest of the long line is skipped and the next row is read', h.received.length === 1 && h.received[0]!.content === 'after the long line', j(h.received))
  h.end()
}

section('S5 — every complete, split and UTF-8 line obeys the byte bound before parsing')
{
  const { MAX_LINE_BYTES } = await import('../../src/runner/wire/errors.ts')
  const prefix = '{"type":"prompt","content":"'
  const suffix = '"}'
  const overhead = Buffer.byteLength(prefix + suffix)
  const exact = prefix + 'x'.repeat(MAX_LINE_BYTES - overhead) + suffix
  const over = prefix + 'x'.repeat(MAX_LINE_BYTES - overhead + 1) + suffix
  const unicode = prefix + '界'.repeat(Math.ceil((MAX_LINE_BYTES - overhead + 1) / 3)) + suffix
  const next = '\ufeff' + j({ type: 'prompt', content: 'NEXT' }) + '\r\n'
  const cases: Array<[string, string[], boolean]> = [
    ['exact ASCII bound', [exact + '\n'], true],
    ['complete ASCII over bound', [over + '\n'], false],
    ['final chunk crosses bound', [over.slice(0, -3), over.slice(-3) + '\n'], false],
    ['complete multibyte over bound', [unicode + '\n'], false],
    ['split multibyte over bound', [unicode.slice(0, -3), unicode.slice(-3) + '\n'], false],
    ['skipped chunks resync once', [over, 'extra', 'more', '\n'], false],
    ['unterminated ASCII over bound', [over], false],
    ['unterminated multibyte over bound', [unicode], false],
  ]
  for (const [name, parts, accepted] of cases) {
    const refused: string[] = []
    const received: string[] = []
    const hasNext = name.startsWith('unterminated') === false
    const io = new StructuredIO((async function* () { yield* parts; if (hasNext) yield next })(), text => refused.push(text))
    for await (const row of io.structuredInput) received.push(row.type === 'prompt' ? String(row.content).slice(0, 8) : row.type)
    check(`${name}: ${accepted ? 'accepted at the bound' : 'one byte-bound refusal'}`, accepted ? refused.length === 0 : refused.length === 1 && refused[0]!.includes(`${MAX_LINE_BYTES} bytes`), j(refused))
    check(`${name}: no oversized prompt reaches the consumer; next row survives`, j(received) === j([...(accepted ? ['xxxxxxxx'] : []), ...(hasNext ? ['NEXT'] : [])]), j(received))
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ STRUCTUREDIO LAWS GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} STRUCTUREDIO LAW FAILURE(S)`)
process.exit(1)
