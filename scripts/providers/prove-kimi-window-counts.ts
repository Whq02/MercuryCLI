#!/usr/bin/env bun
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tally, usagePlanWorld } from './lib/usage-plan-world.ts'

interface RecordedBody { body: Record<string, unknown> }
interface Fixture extends RecordedBody { observed: string; publicBodies: Record<string, RecordedBody & { source: string }> }

const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/kimi-usages-2026-10-04.json'), 'utf8')) as Fixture
const { check, finish } = tally()
const world = await usagePlanWorld()
try {
  const { owner, reader, ink } = world
  const login = await import(world.path('src/models/roads/moonshot/moonshotLogin.ts')) as typeof import('../../src/models/roads/moonshot/moonshotLogin.js')
  const { HelmVitalsRail } = await import(world.path('src/screen/fullscreen-layout/HelmVitalsRail.tsx'))
  const { railPlanAt } = await import(world.path('src/screen/fullscreen-layout/helmGeometry.ts'))
  const percents = (windows: { label: string; usedPct?: number }[]) => windows.map(w => `${w.label}:${w.usedPct}`).join('|')
  const detail = (fixture.body.limits as { detail: { resetTime: string } }[])[0]!.detail
  const captured = Date.parse(fixture.observed)
  world.setNow(captured)
  world.setBody(fixture.body)
  await owner.refreshProviderUsage('moonshot', { fetchImpl: world.fetchImpl, now: world.now, force: true })
  const usage = owner.usageForProvider('moonshot')
  const record = reader.kimiObservedManagedUsage()!
  const fiveHour = record.windows.find(w => w.windowMinutes === 300)
  console.log(`recorded ${fixture.observed}: ${JSON.stringify(record.windows)}`)
  check('the recorded Kimi answer paints the 5-hour window from its stated counts, 97 of 100, not the zero ratio stated beside it', percents(usage.windows) === '5h:97|month:5.38|month code:0', percents(usage.windows) + ' — fix decodeKimiManagedUsage in src/models/roads/moonshot/moonshotUsageState.ts (stated counts win over the ratio) or kimiManagedWindowViews in src/models/roads/provider-usage/moonshot.ts')
  check('the 5-hour window carries the stated counts and reset, and no ratio', fiveHour?.name === '5h' && fiveHour.used === 97 && fiveHour.limit === 100 && fiveHour.usedRatio === undefined && fiveHour.resetsAtMs === Date.parse(detail.resetTime), JSON.stringify(fiveHour) + ' — fix decodeKimiManagedUsage in src/models/roads/moonshot/moonshotUsageState.ts: a window stated with counts keeps used, limit and reset, and no ratio')
  check('the monthly windows stated only as ratios keep their ratios and invent no counts', record.windows.filter(w => w.windowMinutes === undefined).every(w => w.usedRatio !== undefined && w.used === undefined && w.limit === undefined && w.resetsAtMs === Date.parse('2026-11-04T00:00:00Z')), JSON.stringify(record.windows) + ' — fix decodeKimiManagedUsage in src/models/roads/moonshot/moonshotUsageState.ts: a window stated only as a ratio keeps its ratio and gets no invented counts')
  check('one window per stated length: the answer states the 5-hour window twice and the record carries it once', record.windows.length === 3 && usage.windows.map(w => w.key).join('|') === '5h|month|month code', usage.windows.map(w => w.key).join('|') + ' — fix decodeKimiManagedUsage in src/models/roads/moonshot/moonshotUsageState.ts to keep one window per stated length')
  check('the sign-in receipt names the 5-hour window with its counts', login.kimiUsageReceiptLine(record).startsWith('usage 5h 97/100 (97%)'), login.kimiUsageReceiptLine(record) + ' — fix kimiUsageReceiptLine in src/models/roads/moonshot/moonshotLogin.ts')
  world.focus('moonshot')
  const width = railPlanAt(178, true).vitalsW
  const board = await world.mount(React.createElement(ink.Box, { flexDirection: 'row', justifyContent: 'flex-end', width: 178 }, React.createElement(HelmVitalsRail, { width, availRows: 44 })))
  const frame = board.frame()
  world.save('kimi-window-counts-rail', frame)
  check('the rail paints the Kimi 5h bar at 97%, never a 0% bar for it', /5h [█░]{4} 97%/.test(frame) && !/5h [█░]{4} 0%/.test(frame), frame + ' — fix the Kimi 5h bar in src/screen/fullscreen-layout/HelmVitalsRail.tsx or the window views in src/models/roads/provider-usage/moonshot.ts')
  check('the rail stays inside 178x51 without render errors', world.inBounds(frame) && !frame.includes('RENDER ERROR'), 'the rail frame (saved as kimi-window-counts-rail) overflows 178x51 or shows a render error: fix src/screen/fullscreen-layout/HelmVitalsRail.tsx')
  board.close()

  const sept20 = fixture.publicBodies['2026-09-20']!.body
  const sept22 = fixture.publicBodies['2026-09-22']!.body
  const decodedSept20 = reader.decodeKimiManagedUsage(sept20, world.now())!
  const sept20FiveHour = decodedSept20.windows.find(w => w.windowMinutes === 300)
  check('2026-09-20 public body: a window stated as limit and remaining decodes to its counts (0 of 100), and the quota keeps its 100 of 100', sept20FiveHour?.used === 0 && sept20FiveHour.limit === 100 && sept20FiveHour.usedRatio === undefined && decodedSept20.quota?.used === 100 && decodedSept20.quota.limit === 100 && percents(owner.kimiManagedWindowViews(decodedSept20)) === '5h:0|7d:0|quota:100', JSON.stringify(decodedSept20) + ' — fix decodeKimiManagedUsage in src/models/roads/moonshot/moonshotUsageState.ts (limit and remaining decode to counts) or kimiManagedWindowViews in src/models/roads/provider-usage/moonshot.ts')
  const decodedSept22 = reader.decodeKimiManagedUsage(sept22, world.now())!
  check('2026-09-22 public body: counts of 100 of 100 beside a zero ratio paint the 5-hour window exhausted', percents(owner.kimiManagedWindowViews(decodedSept22)) === '5h:100|month:7.95|month code:0', JSON.stringify(decodedSept22) + ' — fix decodeKimiManagedUsage in src/models/roads/moonshot/moonshotUsageState.ts or kimiManagedWindowViews in src/models/roads/provider-usage/moonshot.ts (counts win over a zero ratio)')
  const remainingOnly = reader.decodeKimiManagedUsage({ limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '3', resetTime: detail.resetTime } }] }, world.now())
  check('an answer stating only limit and remaining is readable, 97 of 100', remainingOnly?.windows.length === 1 && remainingOnly.windows[0]?.used === 97 && remainingOnly.windows[0].limit === 100, JSON.stringify(remainingOnly) + ' — fix decodeKimiManagedUsage in src/models/roads/moonshot/moonshotUsageState.ts: limit and remaining give used = limit - remaining')
  const usedAndRemaining = reader.decodeKimiManagedUsage({ limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { used: '97', remaining: '3' } }] }, world.now())
  check('used and remaining state the window as 97 of 100', usedAndRemaining?.windows[0]?.used === 97 && usedAndRemaining.windows[0].limit === 100, JSON.stringify(usedAndRemaining) + ' — fix decodeKimiManagedUsage in src/models/roads/moonshot/moonshotUsageState.ts: used and remaining give limit = used + remaining')
  const otherKeys = reader.decodeKimiManagedUsage({ usages: { limit_1h: { used_ratio: '0.5', reset_time: detail.resetTime }, limit_week_code: { used_ratio: 0.1 }, limit_3d: { usedRatio: 0.2, resetAt: detail.resetTime } } }, world.now())!
  check('a usages key outside the known four is read by its stated name and length, in either spelling of its fields', percents(owner.kimiManagedWindowViews(otherKeys)) === '1h:50|3d:20|week code:10' && otherKeys.windows[0]?.resetsAtMs === Date.parse(detail.resetTime) && otherKeys.windows[2]?.resetsAtMs === Date.parse(detail.resetTime), JSON.stringify(otherKeys.windows) + ' — fix the usages-key reader in decodeKimiManagedUsage in src/models/roads/moonshot/moonshotUsageState.ts')
  const twins = reader.decodeKimiManagedUsage({ usages: { limit_5h: { used_ratio: 0.25 }, limit_7d: { used_ratio: 0.5 } }, limits: [world.fiveHour, { window: { duration: 7, timeUnit: 'TIME_UNIT_DAY' }, detail: { limit: '1000', remaining: '750' } }] }, world.now())!
  check('a ratio twin never outranks stated counts, whatever unit states the length', percents(owner.kimiManagedWindowViews(twins)) === '5h:50|7d:25' && twins.windows.every(w => w.usedRatio === undefined && w.name !== undefined), JSON.stringify(twins.windows) + ' — fix decodeKimiManagedUsage in src/models/roads/moonshot/moonshotUsageState.ts: a ratio from usages must not replace counts stated in limits')
  const unreadable = reader.decodeKimiManagedUsage({ usages: { limit_5h: { used_ratio: null, used: 'many', limit: '100' }, limit_7d: {} }, limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { remaining: '3' } }] }, world.now())
  check('a window with no readable figure is absent, never a zero', unreadable?.windows.length === 0, JSON.stringify(unreadable) + ' — fix decodeKimiManagedUsage in src/models/roads/moonshot/moonshotUsageState.ts: drop a window with no readable figure')
  check('no fixture request escaped loopback', world.escaped.length === 0, JSON.stringify(world.escaped) + ' — a request left the loopback fixture: route it through the fetchImpl the world passes to refreshProviderUsage in src/models/roads/providerUsage.ts')
} finally {
  world.close()
}
finish()
