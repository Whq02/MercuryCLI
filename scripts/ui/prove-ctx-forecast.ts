#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import {
  ctxForecastEnabled,
  estimateTurnsToFold,
  noteCtxTurnBoundary,
  recordCtxSample,
  resetCtxForecastForTest,
} from '../../src/screen/cockpit-gauges/ctxForecast.js'

let fail = 0
const t = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}${ok ? '' : ' — fix ctxForecastEnabled, recordCtxSample, noteCtxTurnBoundary or estimateTurnsToCompact in src/screen/cockpit-gauges/ctxForecast.ts, whichever this check names'}`)
  if (!ok) fail = 1
}

const saved = process.env.MERCURY_CTX_FORECAST
delete process.env.MERCURY_CTX_FORECAST
t('unset ⇒ ENABLED (default-ON graduation)', ctxForecastEnabled())
process.env.MERCURY_CTX_FORECAST = '0'
t('flag =0 ⇒ disabled (opt-out preserved)', !ctxForecastEnabled())
delete process.env.MERCURY_CTX_FORECAST
{
  const savedMacro = (globalThis as Record<string, unknown>).MACRO
  delete (globalThis as Record<string, unknown>).MACRO
  t('no MACRO + unset ⇒ STILL enabled (stamp-independence)', ctxForecastEnabled())
  ;(globalThis as Record<string, unknown>).MACRO = savedMacro
}
if (saved === undefined) delete process.env.MERCURY_CTX_FORECAST
else process.env.MERCURY_CTX_FORECAST = saved

resetCtxForecastForTest()
t('no samples ⇒ null', estimateTurnsToFold(50, 92) === null)
recordCtxSample(40)
recordCtxSample(44)
noteCtxTurnBoundary()
t('one turn ⇒ still null', estimateTurnsToFold(44, 92) === null)

recordCtxSample(48)
noteCtxTurnBoundary()
t('steady growth estimate', estimateTurnsToFold(48, 92) === 11)

resetCtxForecastForTest()
recordCtxSample(40)
noteCtxTurnBoundary()
for (let round = 1; round <= 10; round++) recordCtxSample(40 + round * 0.4)
noteCtxTurnBoundary()
recordCtxSample(48)
noteCtxTurnBoundary()
t('a 10-round turn is ONE observation (4%/turn ⇒ 11, not ~110)', estimateTurnsToFold(48, 92) === 11)

t('over threshold ⇒ 0', estimateTurnsToFold(93, 92) === 0)

recordCtxSample(20)
t('compaction drop resets', estimateTurnsToFold(20, 92) === null)

resetCtxForecastForTest()
recordCtxSample(50)
noteCtxTurnBoundary()
recordCtxSample(50.05)
recordCtxSample(50.09)
noteCtxTurnBoundary()
t('jitter ignored', estimateTurnsToFold(50.09, 92) === null)

resetCtxForecastForTest()
recordCtxSample(50)
noteCtxTurnBoundary()
noteCtxTurnBoundary()
noteCtxTurnBoundary()
t('idle boundaries record nothing', estimateTurnsToFold(50, 92) === null)

resetCtxForecastForTest()
recordCtxSample(40)
noteCtxTurnBoundary()
recordCtxSample(44)
noteCtxTurnBoundary()
recordCtxSample(48)
noteCtxTurnBoundary()
t('null threshold ⇒ null', estimateTurnsToFold(48, null) === null)

console.log(fail ? '❌ CTX-FORECAST RED' : '✅ CTX-FORECAST GREEN')
process.exit(fail)
