#!/usr/bin/env bun
// ============================================================================
//  scripts/context/prove-context-gauges-honest.ts — two gauges tell the
//  truth about what they measure and whether they know it (FN-018 ranks 12
//  and 13).
//
//   · rank 12 — /fullscreen's usage rail printed "5h NN%" from the context
//     gauge (transcript tokens over the model's window) and coerced the
//     gauge's unavailable state to 0%: a calm quota figure unrelated to the
//     quota, a rate-limit colour ramp over a context-fill number, and a
//     fresh session printing a fabricated 0%. The row now reads the
//     five-hour quota window every other meter reads (quota.ts), whose own
//     law forbids coercing unknown to 0.
//   · rank 13 — /model's context gauge resolved its window from the global
//     model, not the session-effective one the frame reads (a 1M session
//     pin over a 200k default: the frame 18%, the picker 90%), and printed
//     a hard 0% when the fill was unknown. It now reads the same channel
//     the frame publishes and carries the null state to the em dash.
//
//   §1 the quota owner's law the rail now rides (unknown ⇒ null, never 0)
//   §2 the fill owner's absent-state word (null ⇒ the em dash)
//   §3 the shape at both call sites and both components
//
//  Run:  ~/.bun/bin/bun run scripts/context/prove-context-gauges-honest.ts
// ============================================================================
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

// ── §1 ──────────────────────────────────────────────────────────────────────
section('§1 the quota owner: an unobserved five-hour window is null, never 0%')
{
  const { quotaWindows } = await import('../../src/utils/cockpit/quota.ts')
  const { fiveHour } = quotaWindows()
  check('with nothing observed the five-hour window is unavailable', fiveHour.state === 'unavailable' && fiveHour.usedPct === null, JSON.stringify(fiveHour))
}

// ── §2 ──────────────────────────────────────────────────────────────────────
section('§2 the fill owner: the absent state is the em dash')
{
  const { contextPercentLabel } = await import('../../src/utils/contextFill.ts')
  check('a null fill prints the em dash, not 0%', contextPercentLabel(null, null) === '—')
  check('a known fill prints its percent', contextPercentLabel(42.4, 'usage') === '42%')
}

// ── §3 ──────────────────────────────────────────────────────────────────────
section('§3 the shape')
{
  const fullscreen = read('src/commands/fullscreen/fullscreen.tsx')
  check('/fullscreen reads the five-hour QUOTA window for its "5h" row (the base read the context gauge)', /const fiveHour = quotaWindows\(\)\.fiveHour/.test(fullscreen) && !/contextGauge\(/.test(fullscreen))
  check('…and passes unknown through as null (never `?? 0`)', /usagePct=\{fiveHour\.usedPct === null \? null : Math\.round\(fiveHour\.usedPct\)\}/.test(fullscreen) && !/usedPct \?\? 0/.test(fullscreen))
  const rail = read('src/components/MercuryFullscreen.tsx')
  check('the rail component accepts the absent state', /usagePct\?: number \| null/.test(rail))
  check('…and paints the em dash for it, the ramp only for a number', /usagePct === null \? <Text color=\{FAINT\}>—<\/Text> : <Text color=\{usagePct < 80/.test(rail))

  const picker = read('src/commands/model/mercuryModel.tsx')
  check("/model's gauge reads the session-effective model the frame publishes (the focused pin, the session override, then the global model)", /getFocusedSessionConnector\(\)\.modelFacts\(\)\.sessionPin \?\? mainLoopModelForSession \?\? mainLoopModel \?\? getMainLoopModel\(\)/.test(picker))
  check('…and never the global model alone', !/contextFillView\(messages, getMainLoopModel\(\)\)/.test(picker))
  check('…carrying the unknown fill as null (the base initialised 0 and left it there)', /let ctxPct: number \| null = null/.test(picker) && !/let ctxPct = 0/.test(picker))
  const pickerView = read('src/components/MercuryModelPicker.tsx')
  check('the picker accepts the absent state', /ctxPct\?: number \| null/.test(pickerView))
  check('…and paints the em dash for it', /ctxPct === null \? <Text color=\{FAINT\}>—<\/Text> :/.test(pickerView))
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-context-gauges-honest${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
