#!/usr/bin/env bun
import React from 'react'
import stringWidth from 'string-width'
import { tally, usagePlanWorld } from '../providers/lib/usage-plan-world.ts'

function providerRuns(runs: string[], title: string): string[] {
  const start = runs.indexOf(title)
  if (start < 0) return []
  const end = runs.findIndex((run, index) => index > start && run.endsWith(' usage'))
  return runs.slice(start + 1, end < 0 ? undefined : end)
}

function meterRuns(runs: string[]): string[] {
  return runs.filter(run => /^█*[▏▎▍▌▋▊▉]? *$/u.test(run) && run.trim() !== '')
}

const { check, finish } = tally()
const world = await usagePlanWorld()
try {
  const { owner, fresh } = world
  const { SettingsPopupSlot } = await import(world.path('src/components/SettingsPopupSlot.tsx'))
  const popup = await import(world.path('src/utils/cockpit/settingsPopup.ts'))
  const { call } = await import(world.path('src/commands/usage/usage.tsx'))
  const { Usage } = await import(world.path('src/components/Settings/Usage.tsx'))
  await call('', {} as never)
  const board = await world.mount(React.createElement(SettingsPopupSlot, { overlay: true }))
  const view = owner.usageForProvider('moonshot')
  const glm = owner.usageForProvider('zai')
  const frame = board.frame()
  const runs = board.runs()
  const kimiRuns = providerRuns(runs, 'Moonshot usage')
  const zaiRuns = providerRuns(runs, 'Z.AI usage')
  const bars = meterRuns(kimiRuns)
  console.log(`Popup Kimi text: ${runs.filter(run => /5h|7d|wk|50%|25%/.test(run)).join(' | ')}`)
  console.log(`Popup Z.AI text: ${glm.absence}`)
  world.save('usage-popup', frame)
  check('/usage opens the real 150x29 popup inside 178x51', popup.settingsPopupRequest()?.width === 150 && popup.settingsPopupRequest()?.rows === 29 && world.inBounds(frame) && !frame.includes('RENDER ERROR'), frame)
  check('both fixture plans are signed in on the popup', frame.includes('Kimi sign-in') && frame.includes('GLM Coding Plan key'), frame)
  check('Kimi uses two actual 42-cell bars, like the Anthropic observed-window meter', bars.length === 2 && bars.every(bar => stringWidth(bar) === 42 && frame.includes(bar.trim())), JSON.stringify(bars))
  check('the painted bar fills match the observed 50% and 25%, not local prompts', bars[0]?.trim() === '█'.repeat(21) && bars[1]?.trim() === `${'█'.repeat(10)}▌` && frame.includes('50%') && frame.includes('25%'), JSON.stringify(bars))
  check('Kimi bars name their stated 5h and 7d windows', frame.includes('Window (5h)') && frame.includes('Current week (7d)'), frame)
  check('Kimi reset lines use the same local reset grammar as Anthropic rows', view.windows.every(window => kimiRuns.includes(`resets ${new Date(window.resetsAtMs!).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`)), kimiRuns.join(' | '))
  check('the five-hour reset includes the stated 18:45 time', kimiRuns.some(run => run.startsWith('resets ') && run.endsWith('18:45')), kimiRuns.join(' | '))
  check('every Kimi bar carries the one source and freshness line', kimiRuns.filter(run => run === fresh.usageSourceWords(view.windows[0]!, world.now())).length === 2, kimiRuns.join(' | '))
  check('the popup paints the complete Z.AI owner sentence exactly once', glm.absence !== undefined && zaiRuns.filter(run => run === glm.absence).length === 1, zaiRuns.join(' | '))
  check('the GLM sentence records this check and offers the documented console link', glm.absence?.includes('checked 2026-09-24') === true && glm.absence.includes('https://z.ai/manage-apikey/subscription'), glm.absence)
  check('the GLM absence is not followed by a second unreported-credits line', zaiRuns.length > 0 && !zaiRuns.some(run => run.startsWith('credits:')), zaiRuns.join(' | '))
  const card = owner.windowSourceUsages({ model: 'glm-fixture' })
  check('popup and sidebar read byte-equal Kimi window views', JSON.stringify(card.others.find(u => u.provider === 'moonshot')?.windows) === JSON.stringify(view.windows))
  check('the popup never polls GLM or sends a chat request', world.requests.length === 1 && world.requests.every(request => request === 'GET /coding/v1/usages'), JSON.stringify(world.requests))

  const requestsBeforeStale = world.requests.length
  world.refuse(true)
  world.setNow(world.observedAtMs + fresh.usageStaleAfterMs() + 60_000)
  await board.repaint(React.createElement(SettingsPopupSlot, { overlay: true }))
  const staleWords = fresh.usageSourceWords(view.windows[0]!, world.now())
  const staleKimiRuns = providerRuns(board.runs(), 'Moonshot usage')
  check('the stale popup re-reads once and the fixture refuses that GET', world.requests.length === requestsBeforeStale + 1 && world.requests.at(-1) === 'GET /coding/v1/usages', JSON.stringify(world.requests.slice(requestsBeforeStale)))
  check('stale Kimi bars retain their values and say stale through the same vocabulary', staleKimiRuns.filter(run => run === staleWords).length === 2 && board.frame().includes('50%') && board.frame().includes('25%'), staleKimiRuns.join(' | '))
  world.save('usage-popup-stale', board.frame())
  board.close()
  popup.closeSettingsPopup()
  world.refuse(false)
  world.setBody({ limits: [world.fiveHour] })
  await owner.refreshProviderUsage('moonshot', { fetchImpl: world.fetchImpl, now: world.now, force: true })
  const narrow = await world.mount(React.createElement(Usage, { width: 116, rowBudget: 22 }))
  const narrowKimiRuns = providerRuns(narrow.runs(), 'Moonshot usage')
  check('a reply with only the 5h window paints one bar and no invented week', meterRuns(narrowKimiRuns).length === 1 && !narrowKimiRuns.some(run => /Current week|Window \(7d\)/.test(run)), narrowKimiRuns.join(' | '))
  check('the stacked body keeps its bars within the supplied width', narrow.frame().split('\n').every(line => stringWidth(line) <= 116))
  narrow.close()
  check('no fixture request escaped loopback', world.escaped.length === 0, JSON.stringify(world.escaped))
} finally {
  world.close()
}
finish()
