#!/usr/bin/env bun
(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const querierFixHint = 'fix TerminalQuerier.settled, whenSettled or terminalQuerySettleMs in src/screen/renderer/terminal-session/terminalQuerier.ts (the flag row is in the flag registry (FLAG_REGISTRY))'
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail}; ` : ''}${querierFixHint}` : ''}`)
}

const { TerminalQuerier, terminalQuerierFor, terminalQuerySettleMs, xtversion, kittyKeyboard } = await import('../../src/screen/renderer/terminal-session/terminalQuerier.ts')
const { FLAG_REGISTRY } = await import('../../src/platform/substrate/flagRegistry.ts')

function makeQuerier(): { querier: InstanceType<typeof TerminalQuerier>; stdout: NodeJS.WriteStream } {
  const stdout = { write: () => true } as unknown as NodeJS.WriteStream
  return { querier: new TerminalQuerier(stdout), stdout }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const da1 = { type: 'da1', params: [62, 22] } as const

console.log('============================================================')
console.log(' the querier\'s settled state: a handover waits for the open batch\'s sentinel, bounded, else drains')
console.log('============================================================')

console.log('\n settled: no closed batch awaits its sentinel')
{
  const { querier, stdout } = makeQuerier()
  check('a fresh querier is settled', querier.settled())
  check('the querier is found by its stream', terminalQuerierFor(stdout) === querier)
  check('a settled querier resolves its wait at once', (await querier.whenSettled(1000)) === 'settled')
  void querier.send(xtversion())
  check('a sent, unflushed query is not on the wire: still settled', querier.settled())
  const flushed = querier.flush()
  check('a flushed batch is open until its sentinel: not settled', !querier.settled())
  const wait = querier.whenSettled(1000)
  querier.onResponse(da1)
  await flushed
  check('the sentinel settles the batch and the wait', querier.settled() && (await wait) === 'settled')
}

console.log('\n the deadline: a batch the terminal never answers is not waited on for ever')
{
  const { querier } = makeQuerier()
  void querier.send(kittyKeyboard())
  void querier.flush()
  const t0 = Date.now()
  const outcome = await querier.whenSettled(40)
  const waited = Date.now() - t0
  check('the wait gives up at the deadline', outcome === 'deadline' && waited >= 35 && waited < 400, `outcome=${outcome} waited=${waited}ms`)
  check('the batch stays open (a late sentinel still settles it)', !querier.settled())
  await sleep(50)
  check('the deadline counts from the flush: a batch older than the deadline is not waited on again', (await querier.whenSettled(40)) === 'deadline' && Date.now() - t0 < 400)
  querier.onResponse(da1)
  check('the late sentinel settles the batch', querier.settled())
}

console.log('\n two batches: the wait holds until the last closed batch is answered')
{
  const { querier } = makeQuerier()
  void querier.send(xtversion())
  void querier.flush()
  void querier.send(kittyKeyboard())
  void querier.flush()
  let outcome: string | null = null
  void querier.whenSettled(1000).then(o => { outcome = o })
  querier.onResponse(da1)
  await sleep(0)
  check('one sentinel for two batches leaves the wait pending', outcome === null && !querier.settled())
  querier.onResponse(da1)
  await sleep(0)
  check('the second sentinel settles it', outcome === 'settled' && querier.settled())
}

console.log('\n the deadline reads the product\'s own flag')
{
  const saved = process.env.MERCURY_TERMINAL_QUERY_SETTLE_MS
  delete process.env.MERCURY_TERMINAL_QUERY_SETTLE_MS
  check('unset reads the default (250 ms)', terminalQuerySettleMs() === 250, String(terminalQuerySettleMs()))
  process.env.MERCURY_TERMINAL_QUERY_SETTLE_MS = '1200'
  check('a number is read live', terminalQuerySettleMs() === 1200)
  process.env.MERCURY_TERMINAL_QUERY_SETTLE_MS = '0'
  check('zero means no wait', terminalQuerySettleMs() === 0)
  {
    const { querier } = makeQuerier()
    void querier.send(xtversion())
    void querier.flush()
    check('with no wait an open batch resolves deadline at once', (await querier.whenSettled()) === 'deadline')
  }
  process.env.MERCURY_TERMINAL_QUERY_SETTLE_MS = 'soon'
  check('junk reads the default', terminalQuerySettleMs() === 250)
  process.env.MERCURY_TERMINAL_QUERY_SETTLE_MS = '-5'
  check('a negative number reads the default', terminalQuerySettleMs() === 250)
  if (saved === undefined) delete process.env.MERCURY_TERMINAL_QUERY_SETTLE_MS
  else process.env.MERCURY_TERMINAL_QUERY_SETTLE_MS = saved
  const row = FLAG_REGISTRY.find(r => r.env === 'MERCURY_TERMINAL_QUERY_SETTLE_MS')
  check('the flag is registered as a value row read by the querier', row?.kind === 'value' && row.consumer === 'src/screen/renderer/terminal-session/terminalQuerier.ts', JSON.stringify(row))
}


console.log(failures === 0 ? '\nGREEN: a handover waits for the open batch, bounded, else drains' : `\nRED: ${failures} check(s) show a handover that races the open query batch`)
process.exit(failures === 0 ? 0 : 1)
