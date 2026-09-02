#!/usr/bin/env bun
// ============================================================================
//  scripts/terminal-boundary/prove-querier-batch.ts — the terminal identity
//  probe batch leaves as ONE write, byte order preserved, mux laws intact.
//
//  TerminalQuerier.send() used to write each query's request immediately —
//  the boot probe (up to 4 sends + flush in one tick, on the path the code
//  itself flags as latency-critical) paid 5 separate writes. send() now
//  buffers the open batch's request bytes and flush() writes requests +
//  sentinel as one syscall. Laws:
//
//   B1  (counted operations + byte identity) 4 sends + flush = exactly ONE
//       write whose bytes are request1..request4 + the DA1 sentinel, in
//       send order — the same byte STREAM the per-send shape produced;
//   B2  the mux semantics do not move: matched responses resolve their
//       queries; the DA1 sentinel resolves flush and the unanswered
//       resolve undefined;
//   B3  batches stay isolated: send A · flush · send B · flush = two
//       writes, [A+S] then [B+S] — cross-batch byte order preserved;
//   B4  a zero-query flush writes the bare sentinel (the existing law).
//
//  Pure — a captured fake stream, no PTY.
//
//  Run: ~/.bun/bin/bun run scripts/terminal-boundary/prove-querier-batch.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

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

const { TerminalQuerier, xtversion, oscColor, decrqm, kittyKeyboard } = await import(
  '../../src/ink/session/querier.ts'
)

const SENTINEL = '\x1b[c'

function makeQuerier(): { querier: InstanceType<typeof TerminalQuerier>; writes: string[] } {
  const writes: string[] = []
  const fake = {
    write(s: string) {
      writes.push(s)
      return true
    },
  } as unknown as NodeJS.WriteStream
  return { querier: new TerminalQuerier(fake), writes }
}

section('B1 · the boot probe shape: 4 sends + flush = one write, bytes in send order')
{
  const { querier, writes } = makeQuerier()
  const qs = [xtversion(), oscColor(11), decrqm(2026), kittyKeyboard()]
  const promises = qs.map(q => querier.send(q as never))
  check('nothing reaches the wire before flush (pair-with-flush is the contract)', writes.length === 0, JSON.stringify(writes))
  const flushed = querier.flush()
  check('exactly ONE write for the whole batch (was 5)', writes.length === 1, `writes=${writes.length}`)
  const expected = qs.map(q => q.request).join('') + SENTINEL
  check('the write is byte-identical to the per-send stream (requests then sentinel)', writes[0] === expected, JSON.stringify({ got: writes[0], expected }).slice(0, 240))
  // B2 rides the same batch: answer one query, then the sentinel.
  querier.onResponse({ type: 'xtversion', name: 'FixtureTerm 1.0' } as never)
  querier.onResponse({ type: 'da1', params: [62, 22] } as never)
  const [version, background, sync, kitty] = await Promise.all(promises)
  await flushed
  check(
    'B2: the matched query resolved with its response; the sentinel resolved the rest undefined',
    (version as { name?: string } | undefined)?.name === 'FixtureTerm 1.0' &&
      background === undefined &&
      sync === undefined &&
      kitty === undefined,
    JSON.stringify({ version, background, sync, kitty }),
  )
}

section('B3 · batch isolation and cross-batch byte order')
{
  const { querier, writes } = makeQuerier()
  const qa = querier.send(decrqm(2026) as never)
  const f1 = querier.flush()
  const qb = querier.send(decrqm(2027) as never)
  const f2 = querier.flush()
  check('two flushes, two writes', writes.length === 2, `writes=${writes.length}`)
  check(
    'each batch carries its own request + sentinel, in order',
    writes[0] === '\x1b[?2026$p' + SENTINEL && writes[1] === '\x1b[?2027$p' + SENTINEL,
    JSON.stringify(writes),
  )
  // First DA1 fires the FIRST closed batch only.
  querier.onResponse({ type: 'da1', params: [62] } as never)
  const aVal = await qa
  await f1
  check('the first sentinel resolved only the first batch', aVal === undefined, JSON.stringify(aVal))
  querier.onResponse({ type: 'decrpm', mode: 2027, status: 1 } as never)
  querier.onResponse({ type: 'da1', params: [62] } as never)
  const bVal = await qb
  await f2
  check('the second batch answered on its own wire', (bVal as { mode?: number } | undefined)?.mode === 2027, JSON.stringify(bVal))
}

section('B4 · a zero-query flush writes the bare sentinel')
{
  const { querier, writes } = makeQuerier()
  const f = querier.flush()
  check('one write, sentinel alone', writes.length === 1 && writes[0] === SENTINEL, JSON.stringify(writes))
  querier.onResponse({ type: 'da1', params: [62] } as never)
  await f
  check('the zero-query flush resolves', true)
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
