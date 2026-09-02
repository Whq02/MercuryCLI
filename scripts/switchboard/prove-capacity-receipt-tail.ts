#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')

const mod = (await import('../../src/services/switchboard/capacityCheck.ts')) as unknown as {
  capacityDecisionReceipt?: (allowed: boolean, seats: number) => string
}
const wrapText = (await import('../../src/ink/wrap-text.ts')).default

console.log('§1 both arms keep their number through the middle cut')
{
  check('the composer is exported (capacityDecisionReceipt)', typeof mod.capacityDecisionReceipt === 'function')
  const receipt = mod.capacityDecisionReceipt ?? ((): string => '')
  for (const [allowed, name] of [
    [true, 'consent'],
    [false, 'decline'],
  ] as const) {
    const line = receipt(allowed, 6)
    check(`the ${name} receipt carries its number`, line.includes('6 seats'), line)
    for (const w of [38, 30, 24]) {
      const cut = wrapText(line, w, 'truncate-middle')
      check(`${name} @ ${w} columns still delivers the number`, cut.includes('6 seats'), cut)
    }
  }
}

console.log('\n§2 the screen consumes the one composer (call-shaped)')
{
  const screen = readFileSync(join(ROOT, 'src', 'components', 'concourse', 'ConcourseScreen.tsx'), 'utf-8')
  check(
    'the receipt routes through capacityDecisionReceipt',
    screen.includes('capacityDecisionReceipt(allowed, r.recommendedSeats)'),
  )
  check(
    'no inline receipt spelling survives',
    !screen.includes('seats fit this machine'),
  )
}

console.log(failures === 0 ? '\nprove-capacity-receipt-tail: all green' : `\nprove-capacity-receipt-tail: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
