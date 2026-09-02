#!/usr/bin/env bun
// ============================================================================
//  scripts/providers/prove-sse-decoder-parity.ts — the cursor-scan SSE
//  decoder is byte-for-byte equivalent to the reference line-splitter.
//
//  The decoder's push() was reshaped from "re-slice the shrinking remainder
//  once per line + a regex per line" to "one cursor, one slice per line, at
//  most one tail slice per chunk". The wire contract must not move: this
//  prover carries the REFERENCE algorithm verbatim as an in-file oracle and
//  drives both over a deterministic fragmentation sweep — every chunk
//  boundary class the wires produce (CRLF and LF, a CR split from its LF
//  across chunks, comments, multi-data joins, empty heartbeats, multi-byte
//  UTF-8 split mid-sequence, dangling EOF) — asserting identical event and
//  fault sequences including flush().
//
//  Run: ~/.bun/bin/bun run scripts/providers/prove-sse-decoder-parity.ts
// ============================================================================
import { StringDecoder } from 'node:string_decoder'
import { SseDecoder, type SseDecodeResult } from '../../src/services/providers/sseDecoder.js'

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

// ── the reference decoder: the pre-reshape algorithm, verbatim ─────────────
class ReferenceSseDecoder {
  private tail = ''
  private dataLines: string[] = []
  private eventType: string | undefined
  private readonly decoder = new StringDecoder('utf8')

  push(chunk: Buffer | string): SseDecodeResult[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    const out: SseDecodeResult[] = []
    let rest = this.tail + text
    for (;;) {
      const nl = rest.indexOf('\n')
      if (nl === -1) break
      const line = rest.slice(0, nl).replace(/\r$/, '')
      rest = rest.slice(nl + 1)
      this.consumeLine(line, out)
    }
    this.tail = rest
    return out
  }

  private consumeLine(line: string, out: SseDecodeResult[]): void {
    if (line === '') {
      if (this.dataLines.length > 0) {
        out.push({
          kind: 'event',
          event: {
            data: this.dataLines.join('\n'),
            ...(this.eventType !== undefined ? { event: this.eventType } : {}),
          },
        })
      }
      this.dataLines = []
      this.eventType = undefined
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') this.dataLines.push(value)
    else if (field === 'event') this.eventType = value
  }

  flush(): SseDecodeResult[] {
    const finalText = this.decoder.end()
    const out: SseDecodeResult[] = []
    if (finalText) {
      const line = (this.tail + finalText).replace(/\r$/, '')
      this.tail = ''
      if (line !== '') this.consumeLine(line, out)
    } else if (this.tail !== '') {
      this.consumeLine(this.tail.replace(/\r$/, ''), out)
      this.tail = ''
    }
    if (this.dataLines.length > 0) {
      out.push({
        kind: 'fault',
        reason: 'dangling-event',
        preview: this.dataLines.join('\n').slice(0, 200),
      })
      this.dataLines = []
      this.eventType = undefined
    }
    return out
  }
}

// ── deterministic fragmentation sweep ──────────────────────────────────────
// A tiny LCG so the sweep is reproducible; the seed is printed on failure.
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const WIRES: Array<[string, string]> = [
  ['plain LF events', 'data: {"a":1}\n\ndata: {"b":2}\n\n'],
  ['CRLF wire', 'event: delta\r\ndata: one\r\n\r\ndata: two\r\n\r\n'],
  ['comment + multi-data join', ': keepalive\ndata: l1\ndata: l2\nevent: ping\n\n'],
  ['empty heartbeats between events', '\n\n\ndata: x\n\n\n\n'],
  ['lone CR inside a line survives', 'data: a\rb\n\n'],
  ['field without colon + unknown fields', 'data\nid: 7\nretry: 100\ndata: tail\n\n'],
  ['unicode payload', 'data: héllo⚡🌊 → done\n\ndata: 終わり\n\n'],
  ['dangling event at EOF', 'data: {"a":1}\n\ndata: half-an-eve'],
  ['dangling with CR tail', 'data: x\n\ndata: y\r'],
  ['long line spanning many chunks', `data: ${'x'.repeat(4096)}\n\ndata: end\n\n`],
]

function drive(
  wire: Buffer,
  cuts: number[],
): { live: SseDecodeResult[]; ref: SseDecodeResult[] } {
  const live = new SseDecoder()
  const ref = new ReferenceSseDecoder()
  const liveOut: SseDecodeResult[] = []
  const refOut: SseDecodeResult[] = []
  let prev = 0
  for (const cut of [...cuts, wire.length]) {
    const piece = wire.subarray(prev, cut)
    prev = cut
    if (piece.length === 0) continue
    liveOut.push(...live.push(piece))
    refOut.push(...ref.push(piece))
  }
  liveOut.push(...live.flush())
  refOut.push(...ref.flush())
  return { live: liveOut, ref: refOut }
}

section('P1 · canonical wires, three deterministic fragmentations each')
for (const [label, text] of WIRES) {
  const wire = Buffer.from(text, 'utf8')
  // whole-buffer, byte-at-a-time, and seeded random cuts
  const byteCuts = Array.from({ length: wire.length }, (_v, i) => i + 1)
  const rand = lcg(wire.length * 2654435761)
  const randomCuts = Array.from(
    new Set(
      Array.from({ length: Math.max(1, Math.floor(wire.length / 3)) }, () =>
        Math.max(1, Math.floor(rand() * wire.length)),
      ),
    ),
  ).sort((a, b) => a - b)
  let ok = true
  let detail = ''
  for (const [cutLabel, cuts] of [
    ['whole', [] as number[]],
    ['byte-at-a-time', byteCuts],
    ['seeded-random', randomCuts],
  ] as const) {
    const { live, ref } = drive(wire, cuts as number[])
    if (JSON.stringify(live) !== JSON.stringify(ref)) {
      ok = false
      detail = `${cutLabel}: live=${JSON.stringify(live).slice(0, 200)} ref=${JSON.stringify(ref).slice(0, 200)}`
      break
    }
  }
  check(`parity: ${label}`, ok, detail)
}

section('P2 · the CR/LF chunk-boundary law (a CR split from its LF)')
{
  // "data: x\r" then "\n\n" — the CR arrives in one chunk, its LF in the
  // next; both decoders must strip exactly one CR.
  const live = new SseDecoder()
  const ref = new ReferenceSseDecoder()
  const a = [...live.push('data: x\r'), ...live.push('\ndata: y\r\n'), ...live.push('\r\n')]
  const b = [...ref.push('data: x\r'), ...ref.push('\ndata: y\r\n'), ...ref.push('\r\n')]
  a.push(...live.flush())
  b.push(...ref.flush())
  check('split-CR parity', JSON.stringify(a) === JSON.stringify(b), JSON.stringify({ a, b }).slice(0, 300))
  const first = a[0] as { kind: string; event?: { data: string } }
  check('the split CR was stripped, the payload joined', first.kind === 'event' && first.event?.data === 'x\ny', JSON.stringify(a).slice(0, 200))
}

section('P3 · multi-byte UTF-8 split across chunk boundaries (parity + intact)')
{
  const wire = Buffer.from('data: héllo⚡🌊\n\n', 'utf8')
  for (let cut = 1; cut < wire.length; cut++) {
    const { live, ref } = drive(wire, [cut])
    if (JSON.stringify(live) !== JSON.stringify(ref)) {
      check(`utf8 parity at cut ${cut}`, false, JSON.stringify({ live, ref }).slice(0, 300))
      break
    }
    if (cut === wire.length - 1) check('utf8 parity at every cut point', true)
  }
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
