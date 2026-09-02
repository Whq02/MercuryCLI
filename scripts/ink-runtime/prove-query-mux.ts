#!/usr/bin/env bun
// ============================================================================
//  scripts/ink-runtime/prove-query-mux.ts — the terminal
//  query multiplexer laws.
//
//  Drives the PRODUCTION byte→event→router chain (parseMultipleKeypresses →
//  TerminalQuerier.onResponse) end to end and pins:
//
//    • ISOLATION — typing interleaved with query responses delivers every
//      key exactly once as a key, and every response to exactly its query;
//      a response never leaks into key input, a key never satisfies a query;
//    • the FLUSH BARRIER — queries the terminal ignored resolve `undefined`
//      when the DA1 sentinel lands; a later batch's pending queries survive
//      the earlier barrier (concurrent callers stay isolated);
//    • the DOUBLE-DA1 design — an explicit da1() query plus a flush() emits
//      two DA1 requests: the first response resolves the query, the second
//      fires the sentinel;
//    • unsolicited responses are dropped silently — no key leak, no crash.
//
//  Run: ~/.bun/bin/bun run scripts/ink-runtime/prove-query-mux.ts
// ============================================================================
import {
  INITIAL_STATE,
  parseMultipleKeypresses,
  type KeyParseState,
  type ParsedInput,
} from '../../src/ink/input/input-decoder.js'
import {
  da1,
  decrqm,
  TerminalQuerier,
  xtversion,
} from '../../src/ink/session/querier.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function makeQuerier(): { querier: TerminalQuerier; requests: () => string } {
  let written = ''
  const fakeStdout = {
    write(s: string) {
      written += s
      return true
    },
  } as NodeJS.WriteStream
  return { querier: new TerminalQuerier(fakeStdout), requests: () => written }
}

/** Route decoded events exactly like App.tsx: responses to the querier,
 *  everything else to the key sink. */
function pump(
  querier: TerminalQuerier,
  state: KeyParseState,
  bytes: string,
  keys: ParsedInput[],
): KeyParseState {
  const [events, next] = parseMultipleKeypresses(state, bytes)
  for (const ev of events) {
    if (ev.kind === 'response') querier.onResponse(ev.response)
    else keys.push(ev)
  }
  return next
}

console.log('bedrock query mux — byte→event→router isolation laws')

// -- Law 1: interleaved typing and responses stay isolated ---------------------
{
  const { querier } = makeQuerier()
  let state: KeyParseState = { ...INITIAL_STATE }
  const keys: ParsedInput[] = []
  let syncResult: unknown = 'unresolved'
  void querier.send(decrqm(2026)).then(r => (syncResult = r))

  state = pump(querier, state, 'ab', keys)
  state = pump(querier, state, '\x1b[?2026;1$y', keys)
  state = pump(querier, state, 'cd', keys)
  await Promise.resolve()

  const typed = keys
    .map(k => ('raw' in k ? (k.raw ?? k.sequence) : k.sequence))
    .join('')
  check('all typed keys delivered exactly once', typed === 'abcd', JSON.stringify(typed))
  check('no response leaked into the key stream', keys.every(k => k.kind !== 'response'))
  check(
    'the query resolved with its response',
    (syncResult as { type?: string; mode?: number })?.type === 'decrpm' &&
      (syncResult as { mode?: number }).mode === 2026,
    JSON.stringify(syncResult),
  )
}

// -- Law 2: the flush barrier + concurrent-batch isolation ---------------------
{
  const { querier } = makeQuerier()
  let state: KeyParseState = { ...INITIAL_STATE }
  const keys: ParsedInput[] = []

  let ignored: unknown = 'unresolved'
  let flushed = false
  let laterBatch: unknown = 'unresolved'

  void querier.send(xtversion()).then(r => (ignored = r)) // terminal will ignore this
  void querier.flush().then(() => (flushed = true))
  void querier.send(decrqm(2004)).then(r => (laterBatch = r)) // queued AFTER the barrier

  // The terminal answers DA1 (the sentinel) without answering xtversion.
  state = pump(querier, state, '\x1b[?1;2c', keys)
  await Promise.resolve()
  check('ignored query resolved undefined at the barrier', ignored === undefined, JSON.stringify(ignored))
  check('flush() completed at the barrier', flushed)
  check('the later batch survived the earlier barrier', laterBatch === 'unresolved')

  // Now the later batch's response arrives.
  state = pump(querier, state, '\x1b[?2004;2$y', keys)
  await Promise.resolve()
  check(
    'the later batch resolved with its own response',
    (laterBatch as { mode?: number })?.mode === 2004,
    JSON.stringify(laterBatch),
  )
  check('no keys were fabricated by the mux', keys.length === 0, JSON.stringify(keys))
}

// -- Law 3: explicit da1() + flush() — the double-DA1 design -------------------
{
  const { querier, requests } = makeQuerier()
  let state: KeyParseState = { ...INITIAL_STATE }
  const keys: ParsedInput[] = []
  let daResult: unknown = 'unresolved'
  let flushed = false
  void querier.send(da1()).then(r => (daResult = r))
  void querier.flush().then(() => (flushed = true))
  check('two DA1 requests were written', (requests().match(/\x1b\[c/g) ?? []).length === 2)

  state = pump(querier, state, '\x1b[?1;2c', keys)
  await Promise.resolve()
  check('first DA1 response resolved the explicit query', (daResult as { type?: string })?.type === 'da1')
  check('sentinel still pending after the first response', !flushed)

  state = pump(querier, state, '\x1b[?1;2c', keys)
  await Promise.resolve()
  check('second DA1 response fired the sentinel', flushed)
}

// -- Law 4: unsolicited responses drop silently --------------------------------
{
  const { querier } = makeQuerier()
  let state: KeyParseState = { ...INITIAL_STATE }
  const keys: ParsedInput[] = []
  state = pump(querier, state, '\x1b[?2026;2$y', keys) // nobody asked
  state = pump(querier, state, 'x', keys)
  const typed = keys.map(k => ('raw' in k ? (k.raw ?? k.sequence) : k.sequence)).join('')
  check('unsolicited response dropped, key stream intact', typed === 'x', JSON.stringify(typed))
}

if (failures > 0) {
  console.log(`\nbedrock query mux: RED (${failures} failure${failures === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log('\nbedrock query mux: green')
