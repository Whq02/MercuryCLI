#!/usr/bin/env bun
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

{
  const { querier } = makeQuerier()
  let state: KeyParseState = { ...INITIAL_STATE }
  const keys: ParsedInput[] = []

  let ignored: unknown = 'unresolved'
  let flushed = false
  let laterBatch: unknown = 'unresolved'

  void querier.send(xtversion()).then(r => (ignored = r))
  void querier.flush().then(() => (flushed = true))
  void querier.send(decrqm(2004)).then(r => (laterBatch = r))

  state = pump(querier, state, '\x1b[?1;2c', keys)
  await Promise.resolve()
  check('ignored query resolved undefined at the barrier', ignored === undefined, JSON.stringify(ignored))
  check('flush() completed at the barrier', flushed)
  check('the later batch survived the earlier barrier', laterBatch === 'unresolved')

  state = pump(querier, state, '\x1b[?2004;2$y', keys)
  await Promise.resolve()
  check(
    'the later batch resolved with its own response',
    (laterBatch as { mode?: number })?.mode === 2004,
    JSON.stringify(laterBatch),
  )
  check('no keys were fabricated by the mux', keys.length === 0, JSON.stringify(keys))
}

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

{
  const { querier } = makeQuerier()
  let state: KeyParseState = { ...INITIAL_STATE }
  const keys: ParsedInput[] = []
  state = pump(querier, state, '\x1b[?2026;2$y', keys)
  state = pump(querier, state, 'x', keys)
  const typed = keys.map(k => ('raw' in k ? (k.raw ?? k.sequence) : k.sequence)).join('')
  check('unsolicited response dropped, key stream intact', typed === 'x', JSON.stringify(typed))
}

if (failures > 0) {
  console.log(`\nbedrock query mux: RED (${failures} failure${failures === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log('\nbedrock query mux: green')
