#!/usr/bin/env bun
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
  '../../src/screen/renderer/terminal-session/terminalQuerier.ts'
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
  check('nothing reaches the wire before flush (pair-with-flush is the contract)', writes.length === 0, JSON.stringify(writes) + ' — send() in src/screen/renderer/terminal-session/terminalQuerier.ts must only queue the request into pendingRequests; the write belongs to flush()')
  const flushed = querier.flush()
  check('exactly ONE write for the whole batch (was 5)', writes.length === 1, `writes=${writes.length} — flush() in src/screen/renderer/terminal-session/terminalQuerier.ts must write pendingRequests + SENTINEL once through termWrite`)
  const expected = qs.map(q => q.request).join('') + SENTINEL
  check('the write is byte-identical to the per-send stream (requests then sentinel)', writes[0] === expected, JSON.stringify({ got: writes[0], expected }).slice(0, 240) + ' — flush() in src/screen/renderer/terminal-session/terminalQuerier.ts must write the queued requests in send order, then the sentinel')
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
    JSON.stringify({ version, background, sync, kitty }) +
      ' — onResponse() must resolve the matching query with its response, and closeBatch() must resolve the unanswered queries undefined (src/screen/renderer/terminal-session/terminalQuerier.ts)',
  )
}

section('B3 · batch isolation and cross-batch byte order')
{
  const { querier, writes } = makeQuerier()
  const qa = querier.send(decrqm(2026) as never)
  const f1 = querier.flush()
  const qb = querier.send(decrqm(2027) as never)
  const f2 = querier.flush()
  check('two flushes, two writes', writes.length === 2, `writes=${writes.length} — each flush() in src/screen/renderer/terminal-session/terminalQuerier.ts must make its own write`)
  check(
    'each batch carries its own request + sentinel, in order',
    writes[0] === '\x1b[?2026$p' + SENTINEL && writes[1] === '\x1b[?2027$p' + SENTINEL,
    JSON.stringify(writes) + ' — flush() in src/screen/renderer/terminal-session/terminalQuerier.ts must write only the requests of its own batch, then the sentinel',
  )
  querier.onResponse({ type: 'da1', params: [62] } as never)
  const aVal = await qa
  await f1
  check('the first sentinel resolved only the first batch', aVal === undefined, JSON.stringify(aVal) + ' — onResponse() in src/screen/renderer/terminal-session/terminalQuerier.ts must close only the oldest flushed batch on a da1 sentinel')
  querier.onResponse({ type: 'decrpm', mode: 2027, status: 1 } as never)
  querier.onResponse({ type: 'da1', params: [62] } as never)
  const bVal = await qb
  await f2
  check('the second batch answered on its own wire', (bVal as { mode?: number } | undefined)?.mode === 2027, JSON.stringify(bVal) + ' — onResponse() in src/screen/renderer/terminal-session/terminalQuerier.ts must match a reply against the queries of every open batch')
}

section('B4 · a zero-query flush writes the bare sentinel')
{
  const { querier, writes } = makeQuerier()
  const f = querier.flush()
  check('one write, sentinel alone', writes.length === 1 && writes[0] === SENTINEL, JSON.stringify(writes) + ' — flush() in src/screen/renderer/terminal-session/terminalQuerier.ts must write the bare sentinel when no query is queued')
  querier.onResponse({ type: 'da1', params: [62] } as never)
  await f
  check('the zero-query flush resolves', true)
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
