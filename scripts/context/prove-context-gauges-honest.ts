#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-gauges-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('two gauges say what they measure and whether they know it')

section('§1 the quota owner: an unobserved five-hour window is null, never 0%')
{
  const { quotaWindows } = await import('../../src/screen/cockpit-gauges/quota.ts')
  const { fiveHour } = quotaWindows()
  check('with nothing observed the five-hour window is unavailable', fiveHour.state === 'unavailable' && fiveHour.usedPct === null, JSON.stringify(fiveHour) + ' — quotaWindows in src/screen/cockpit-gauges/quota.ts must report state unavailable and usedPct null until a window is observed, never 0')
}

section('§2 the fill owner: the absent state is the em dash')
{
  const { contextPercentLabel } = await import('../../src/engine/context-window/contextFill.ts')
  check('a null fill prints the em dash, not 0%', contextPercentLabel(null, null) === '—', 'contextPercentLabel in src/engine/context-window/contextFill.ts must return the em dash for a null fill')
  check('a known fill prints its percent', contextPercentLabel(42.4, 'usage') === '42%', 'contextPercentLabel in src/engine/context-window/contextFill.ts must return the rounded percent for a known fill')
}


console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-context-gauges-honest${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
