#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-chat-forward-first-paint-'))

let failures = 0
let where = ''
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${!cond && where ? ` — ${where}` : ''}`)
}
function section(title: string, hint = ''): void {
  where = hint
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' the chat-forward boot paints first, and a refusal speaks')
console.log('============================================================')


section('§1 withLanding — the gate is armed BEFORE the first await', 'change withLanding or landingInFlight in src/engine/connector/focusedConnector.ts')
{
  const { withLanding, landingInFlight } = await import('../../src/engine/connector/focusedConnector.ts')
  check('no landing at rest', landingInFlight() === false)
  let release: (v: string) => void = () => {}
  const pending = new Promise<string>(r => {
    release = r
  })
  const landed = withLanding(pending)
  check('the gate is in flight on the SAME tick the landing starts (an unawaited birth still holds the face)', landingInFlight() === true)
  release('done')
  check('the landing resolves to its own value', (await landed) === 'done')
  check('the gate clears once it settles', landingInFlight() === false)
  const refused = withLanding(Promise.reject(new Error('refused')))
  check('a rejected landing is in flight while it runs', landingInFlight() === true)
  await refused.catch(() => undefined)
  check('a rejected landing still clears the gate', landingInFlight() === false)
}


section('§4 a refused birth reaches the screen (the seat-receipt seam)', 'change mintImmediateReceipt or subscribeSeatReceipts in src/models/facts/seatReceipts.ts')
{
  const receipts = await import('../../src/models/facts/seatReceipts.ts')
  receipts.mintImmediateReceipt('▲ the first receipt', 'warning')
  receipts.mintImmediateReceipt('▲ the second receipt', 'warning')
  const seen: Array<{ text: string; level: string }> = []
  const stop = receipts.subscribeSeatReceipts(r => seen.push({ text: r.text, level: r.level }))
  check('a receipt minted before the screen mounts still reaches it', seen.length === 2, JSON.stringify(seen))
  check('…in order, at the level it was minted', seen[0]?.text === '▲ the first receipt' && seen[1]?.text === '▲ the second receipt' && seen.every(r => r.level === 'warning'))
  stop()
}


console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-chat-forward-first-paint${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
