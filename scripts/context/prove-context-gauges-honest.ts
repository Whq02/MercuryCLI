#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
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
const ROOT = join(import.meta.dir, '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

console.log('two gauges say what they measure and whether they know it')

section('§1 the quota owner: an unobserved five-hour window is null, never 0%')
{
  const { quotaWindows } = await import('../../src/utils/cockpit/quota.ts')
  const { fiveHour } = quotaWindows()
  check('with nothing observed the five-hour window is unavailable', fiveHour.state === 'unavailable' && fiveHour.usedPct === null, JSON.stringify(fiveHour))
}

section('§2 the fill owner: the absent state is the em dash')
{
  const { contextPercentLabel } = await import('../../src/utils/contextFill.ts')
  check('a null fill prints the em dash, not 0%', contextPercentLabel(null, null) === '—')
  check('a known fill prints its percent', contextPercentLabel(42.4, 'usage') === '42%')
}

section('§3 the shape')
{
  const fullscreen = read('src/commands/fullscreen/fullscreen.tsx')
  check('/fullscreen reads the five-hour QUOTA window for its "5h" row (the base read the context gauge)', /const fiveHour = quotaWindows\(\)\.fiveHour/.test(fullscreen) && !/contextGauge\(/.test(fullscreen))
  check('…and passes unknown through as null (never `?? 0`)', /usagePct=\{fiveHour\.usedPct === null \? null : Math\.round\(fiveHour\.usedPct\)\}/.test(fullscreen) && !/usedPct \?\? 0/.test(fullscreen))
  const rail = read('src/components/MercuryFullscreen.tsx')
  check('the rail component accepts the absent state', /usagePct\?: number \| null/.test(rail))
  check('…and paints the em dash for it, the ramp only for a number', /usagePct === null \? <Text color=\{FAINT\}>—<\/Text> : <Text color=\{usagePct < 80/.test(rail))

  const picker = read('src/commands/model/mercuryModel.tsx')
  check("/model's gauge reads the served model (the focused seat's effective row, the session override, then the global model)", /const servedModel = focusedSeat !== null \? focusedSeat\.effective : \(mainLoopModelForSession \?\? getMainLoopModel\(\)\)/.test(picker) && /contextFillView\(messages, servedModel\)/.test(picker))
  check('…and never the global model alone', !/contextFillView\(messages, getMainLoopModel\(\)\)/.test(picker))
  check('…carrying the unknown fill as null (the base initialised 0 and left it there)', /let ctxPct: number \| null = null/.test(picker) && !/let ctxPct = 0/.test(picker))
  const pickerView = read('src/components/MercuryModelPicker.tsx')
  check('the picker accepts the absent state', /ctxPct\?: number \| null/.test(pickerView))
  check('…and paints the em dash for it', /ctxPct === null \? <Text color=\{FAINT\}>—<\/Text> :/.test(pickerView))
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-context-gauges-honest${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
