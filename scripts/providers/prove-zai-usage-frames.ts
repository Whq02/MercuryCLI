#!/usr/bin/env bun
import React from 'react'
import { existsSync } from 'node:fs'
import stringWidth from 'string-width'
import { tally, usagePlanWorld } from './lib/usage-plan-world.ts'

const WIDE = { columns: 178, rows: 51 }
const NARROW = { columns: 80, rows: 21 }

function rawBlockRuns(raw: string[], title: string): string[] {
  const runs = raw.map(run => run.trim())
  const start = runs.indexOf(title)
  if (start < 0) return []
  const end = runs.findIndex((run, index) => index > start && (run.endsWith(' usage') || /^[^\p{L}\p{N}] [A-Z]{2,}/u.test(run)))
  return raw.slice(start, end < 0 ? undefined : end)
}

function blockRuns(raw: string[], title: string): string[] {
  return rawBlockRuns(raw, title).map(run => run.trim())
}

function railBlock(runs: string[], provider: 'zai' | 'moonshot'): string[] {
  const titles = provider === 'zai' ? ['GLM Coding Plan usage', 'Z.AI usage'] : ['Kimi usage', 'Moonshot usage']
  for (const title of titles) {
    const block = blockRuns(runs, title)
    if (block.length > 0) return block
  }
  return []
}

const ageWords = (fresh: { usageAgeWords: (facts: { source?: 'endpoint' | 'headers' | 'seed'; observedAtMs?: number; freshForMs?: number }, now?: number) => string | undefined }, view: { source?: 'endpoint' | 'headers' | 'seed'; observedAtMs?: number; freshForMs?: number } | undefined, now: number): string =>
  view === undefined ? '(no window view)' : (fresh.usageAgeWords(view, now) ?? '(unstamped)')

function meterRuns(runs: string[]): string[] {
  return runs.filter(run => /^█*[▏▎▍▌▋▊▉]? *$/u.test(run) && run.trim() !== '')
}

const quote = (rows: string[]) => (rows.length === 0 ? '(no block)' : rows.map(row => `「${row}」`).join(' '))

type Size = { columns: number; rows: number }
type PopupFrame = { left: number; right: number; top: number; bottom: number; rows: string[] }
type PopupAsk = { width: number | ((hostColumns: number) => number); rows: number | null }
const POPUP_TITLE = 'Mercury · usage'
const cellsOf = (frame: string): string[][] => frame.split('\n').map(line => Array.from(line))
const cellAt = (cells: string[][], x: number, y: number): string => cells[y]?.[x] ?? ' '

function popupFrameOf(frame: string, title = POPUP_TITLE): PopupFrame | null {
  const cells = cellsOf(frame)
  const y = cells.findIndex(line => line.join('').includes(title))
  if (y < 0) return null
  const titleAt = Array.from(cells[y]!.join('').slice(0, cells[y]!.join('').indexOf(title))).length
  const left = cells[y]!.lastIndexOf('│', titleAt)
  if (left < 0) return null
  let top = y
  while (top >= 0 && !'╭┌'.includes(cellAt(cells, left, top))) top--
  if (top < 0) return null
  const right = cells[top]!.findIndex((cell, x) => x > left && '╮┐'.includes(cell))
  let bottom = top + 1
  while (bottom < cells.length && !'╰└'.includes(cellAt(cells, left, bottom))) bottom++
  if (right < 0 || bottom >= cells.length) return null
  const rows = cells.slice(top, bottom + 1).map(line => Array.from({ length: right - left + 1 }, (_, x) => line[left + x] ?? ' ').join(''))
  return { left, right, top, bottom, rows }
}

function popupFrameLaw(frame: string, at: Size, ask: PopupAsk, gutter: number, fit: (requested: number, columns: number) => number): string[] {
  const box = popupFrameOf(frame)
  if (box === null) return [`no rounded frame carries the title ${POPUP_TITLE}`]
  const cells = cellsOf(frame)
  const faults: string[] = []
  const { left, right, top, bottom } = box
  const width = right - left + 1
  const height = bottom - top + 1
  const askedWidth = typeof ask.width === 'function' ? ask.width(fit(at.columns, at.columns)) : ask.width
  const wantWidth = fit(askedWidth, at.columns)
  const wantHeight = ask.rows === null ? height : Math.min(ask.rows, at.rows - 2 * gutter)
  if (box.rows[0] !== `╭${'─'.repeat(width - 2)}╮` || box.rows.at(-1) !== `╰${'─'.repeat(width - 2)}╯`) faults.push(`the corners are not rounded and whole: ${box.rows[0]} / ${box.rows.at(-1)}`)
  const cut = box.rows.slice(1, -1).map((row, index) => (row.startsWith('│') && row.endsWith('│') ? -1 : top + 1 + index)).filter(row => row >= 0)
  if (cut.length > 0) faults.push(`rows without both border cells: ${cut.join(',')}`)
  if (left < gutter || right > at.columns - 1 - gutter || top < gutter || bottom > at.rows - 1 - gutter) faults.push(`the frame ${left}..${right} × ${top}..${bottom} leaves no ${gutter}-cell gutter inside ${at.columns}x${at.rows}`)
  if (width !== wantWidth) faults.push(`${width} wide, the request sized to the host is ${wantWidth}`)
  if (height !== wantHeight) faults.push(`${height} rows, the request clamped to the host is ${wantHeight}`)
  if (left !== Math.max(gutter, Math.floor((at.columns - width) / 2))) faults.push(`left ${left}, centred would be ${Math.max(gutter, Math.floor((at.columns - width) / 2))}`)
  const dirty: string[] = []
  for (let y = top - gutter; y <= bottom + gutter; y++) for (let x = left - gutter; x <= right + gutter; x++) {
    if (y >= top && y <= bottom && x >= left && x <= right) continue
    if (cellAt(cells, x, y) !== ' ') dirty.push(`${x},${y}=${JSON.stringify(cellAt(cells, x, y))}`)
  }
  if (dirty.length > 0) faults.push(`live cells in the gutter: ${dirty.slice(0, 6).join(' ')}`)
  return faults
}

function poisoned(frame: string, box: PopupFrame, poison: 'square corners' | 'a live cell in the gutter' | 'the frame on the host edge' | 'a cut row'): string {
  const cells = cellsOf(frame)
  const put = (x: number, y: number, glyph: string) => { while ((cells[y] ?? (cells[y] = [])).length <= x) cells[y]!.push(' '); cells[y]![x] = glyph }
  if (poison === 'square corners') {
    put(box.left, box.top, '┌'); put(box.right, box.top, '┐'); put(box.left, box.bottom, '└'); put(box.right, box.bottom, '┘')
  } else if (poison === 'a live cell in the gutter') put(box.left - 1, box.top + 1, 'T')
  else if (poison === 'a cut row') put(box.right, box.top + 2, ' ')
  else for (let y = box.top; y <= box.bottom; y++) cells[y] = cells[y]!.slice(box.left)
  return cells.map(line => line.join('')).join('\n')
}

const { check, finish } = tally()
const world = await usagePlanWorld()
try {
  const { owner, fresh, quota, ink } = world
  const { HelmTelemetryRail } = await import(world.path('src/components/HelmTelemetryRail.tsx'))
  const { railPlanAt } = await import(world.path('src/utils/helmGeometry.ts'))
  const { SettingsPopupSlot } = await import(world.path('src/components/SettingsPopupSlot.tsx'))
  const { POPUP_GUTTER, popupWidth } = await import(world.path('src/components/PopupGutter.tsx'))
  const popup = await import(world.path('src/utils/cockpit/settingsPopup.ts'))
  const { call } = await import(world.path('src/commands/usage/usage.tsx'))
  const frameLaw = (frame: string, at: Size): string[] => {
    const ask = popup.settingsPopupRequest()
    return ask === null ? ['no /usage request is open'] : popupFrameLaw(frame, at, ask, POPUP_GUTTER, popupWidth)
  }
  const card = (columns: number, rows: number) => React.createElement(ink.Box, { flexDirection: 'row', justifyContent: 'flex-end', width: columns }, React.createElement(HelmTelemetryRail, { width: railPlanAt(columns, true).telemetryW, availRows: rows - 7 }))
  const glm = owner.usageForProvider('zai')
  const kimi = owner.usageForProvider('moonshot')
  console.log(`Z.AI owner: shape ${glm.shape} · windows ${JSON.stringify(glm.windows.map(w => `${w.key}:${w.usedPct}`))} · absence ${glm.absence ?? '—'} · tier ${glm.tier}`)
  console.log(`fixture wire: ${JSON.stringify(world.requests)} · quota auth forms ${JSON.stringify(world.quotaAuthForms)}`)

  check('the fixture served exactly the Kimi read and ONE GLM quota read, the GLM key sent raw', world.requests.filter(r => r === 'GET /api/monitor/usage/quota/limit').length === 1 && world.requests.filter(r => r === 'GET /coding/v1/usages').length === 1 && world.quotaAuthForms.join(',') === 'raw', `${JSON.stringify(world.requests)} forms ${JSON.stringify(world.quotaAuthForms)}`)
  check('the owner reads GLM as subscription windows: 5h 17% and 7d 3%, each with its reset', glm.shape === 'subscription-windows' && glm.windows.map(w => `${w.key}:${w.usedPct}`).join('|') === '5h:17|7d:3' && glm.windows[0]?.resetsAtMs === world.glmFiveHourResetAtMs && glm.windows[1]?.resetsAtMs === world.glmWeekResetAtMs, `shape ${glm.shape}; windows ${JSON.stringify(glm.windows)}; absence ${glm.absence}`)
  check('the Kimi views are untouched beside it', kimi.windows.map(w => `${w.label}:${w.usedPct}`).join('|') === '5h:50|7d:25', JSON.stringify(kimi.windows))

  const board = await world.mount(card(WIDE.columns, WIDE.rows), WIDE)
  const frame = board.frame()
  const glmRows = railBlock(board.runs(), 'zai')
  const kimiRows = railBlock(board.runs(), 'moonshot')
  world.save('usage-card-glm-focused', frame, WIDE)
  console.log(`rail GLM block rows: ${quote(glmRows)}`)
  console.log(`rail Kimi block rows: ${quote(kimiRows)}`)
  check("178x51 rail, GLM focused: the GLM block prints actual 5h and 7d mini-bars with the stated percents (the same grammar as Kimi's rows)", /5h [█░]{4} 17%/.test(frame) && /7d [█░]{4} 3%/.test(frame), `GLM block rows: ${quote(glmRows)}`)
  check('178x51 rail: the GLM block carries the two provider-stated resets on their own rows', glmRows.includes(`resets ${quota.formatClock(world.glmFiveHourResetAtMs)}`) && glmRows.includes(`resets ${quota.formatClock(world.glmWeekResetAtMs)}`), `GLM block rows: ${quote(glmRows)}`)
  check('178x51 rail: the GLM block carries the read age in the one vocabulary under each meter', glmRows.filter(row => row === ageWords(fresh, glm.windows[0], world.now())).length === 2, `GLM block rows: ${quote(glmRows)}`)
  check("178x51 rail: the GLM block's rows are the same shape as the Kimi block's rows (label, the identity row under it, then bar, resets, read age, twice; Kimi's block ends with the credits line its sign-in states, a coding plan states none)", kimiRows.length === glmRows.length + 1 && glmRows.length === 8 && /^credits /.test(kimiRows[8] ?? '') && glmRows[1] === 'Coding Plan key · …-key' && /^5h /.test(glmRows[2] ?? '') && /^Kimi account/.test(kimiRows[1] ?? '') && /^5h /.test(kimiRows[2] ?? ''), `GLM ${quote(glmRows)} vs Kimi ${quote(kimiRows)}`)
  check('178x51 rail: the Kimi block paints beside it with its own pair', /5h [█░]{4} 50%/.test(frame) && /7d [█░]{4} 25%/.test(frame), quote(kimiRows))
  check('178x51 rail: no absence sentence, no dated claim, no console link on the GLM block', !glmRows.some(row => /No Z\.AI usage read|checked 20|manage-apikey/.test(row)), quote(glmRows))
  check('178x51 rail: the frame stays inside 178x51 without render errors', world.inBounds(frame, WIDE) && !frame.includes('RENDER ERROR'))

  world.focus('moonshot')
  await board.repaint(card(WIDE.columns, WIDE.rows))
  const kimiFocused = board.frame()
  const besideRows = railBlock(board.runs(), 'zai')
  world.save('usage-card-kimi-focused', kimiFocused, WIDE)
  console.log(`rail GLM beside-block rows (Kimi focused): ${quote(besideRows)}`)
  check('178x51 rail, Kimi focused: the GLM block rides beside as an other account with the same rows', /5h [█░]{4} 17%/.test(kimiFocused) && /7d [█░]{4} 3%/.test(kimiFocused) && besideRows.includes(`resets ${quota.formatClock(world.glmFiveHourResetAtMs)}`) && besideRows.filter(row => row === ageWords(fresh, glm.windows[0], world.now())).length === 2, quote(besideRows))
  world.focus('zai')

  await call('', {} as never)
  const popupBoard = await world.mount(React.createElement(SettingsPopupSlot, { overlay: true }), WIDE)
  const popupFrame = popupBoard.frame()
  const popupRuns = popupBoard.runs()
  const zaiRuns = blockRuns(popupRuns, 'Z.AI usage')
  const kimiPopupRuns = blockRuns(popupRuns, 'Moonshot usage')
  world.save('usage-popup', popupFrame, WIDE)
  console.log(`popup Z.AI section: ${quote(zaiRuns)}`)
  const wideBox = popupFrameOf(popupFrame)
  const wideFaults = frameLaw(popupFrame, WIDE)
  console.log(`178x51 popup frame: ${wideBox === null ? '(none)' : `${wideBox.right - wideBox.left + 1}x${wideBox.bottom - wideBox.top + 1} at column ${wideBox.left} row ${wideBox.top}`} · faults ${JSON.stringify(wideFaults)}`)
  check('178x51 popup: the /usage pop-up paints inside the frame the design draws — a rounded frame sized to the host (its 150-column ask fits 178), never wider than the host minus the one-cell gutter, centred, every gutter cell blank', wideFaults.length === 0 && world.inBounds(popupFrame, WIDE) && !popupFrame.includes('RENDER ERROR'), wideFaults.length > 0 ? wideFaults.join(' · ') : popupFrame)
  check("178x51 popup: the Z.AI section's rows ride inside the frame, the title and both windows among them", wideBox !== null && ['Z.AI usage', 'Window (5h) · 17%', 'Current week (7d) · 3%'].every(words => wideBox.rows.some(row => row.includes(words))), wideBox === null ? '(no frame)' : quote(wideBox.rows.filter(row => /Z\.AI|Window \(5h\)|Current week/.test(row))))
  for (const poison of ['square corners', 'a live cell in the gutter', 'the frame on the host edge', 'a cut row'] as const) {
    const faults = wideBox === null ? [] : frameLaw(poisoned(popupFrame, wideBox, poison), WIDE)
    console.log(`poison ${poison}: ${faults.join(' · ') || '(no fault)'}`)
    check(`178x51 popup: the frame law refuses ${poison}`, wideBox !== null && faults.length > 0, JSON.stringify(faults))
  }
  const zaiBars = meterRuns(rawBlockRuns(popupRuns, 'Z.AI usage'))
  check("178x51 popup: the Z.AI section paints two 42-cell bars titled like Kimi's — 'Window (5h)' and 'Current week (7d)'", zaiBars.length === 2 && zaiBars.every(bar => stringWidth(bar) === 42) && zaiRuns.some(run => run.startsWith('Window (5h)')) && zaiRuns.some(run => run.startsWith('Current week (7d)')), `bars ${JSON.stringify(zaiBars)} · ${quote(zaiRuns)}`)
  check('178x51 popup: the bar fills are the stated 17% (7.14 of 42 cells) and 3% (1.26 cells), and say so', zaiBars[0]?.trim() === '███████▏' && zaiBars[1]?.trim() === '█▎' && zaiRuns.some(run => run.includes('17%')) && zaiRuns.some(run => run.includes('3%')), JSON.stringify(zaiBars))
  check('178x51 popup: each Z.AI bar carries the same reset grammar and the same source + freshness line as the Kimi bars', glm.windows.length === 2 && glm.windows.every(w => zaiRuns.includes(`resets ${new Date(w.resetsAtMs!).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`)) && zaiRuns.filter(run => run === fresh.usageSourceWords(glm.windows[0]!, world.now())).length >= 2, quote(zaiRuns))
  check("178x51 popup: the tier line names the plan the wire stated ('GLM Coding Pro')", zaiRuns.some(run => run.includes('GLM Coding Pro')), quote(zaiRuns))
  check("178x51 popup: the monthly tool-call quota rides as one figure line ('2 of 1000 MCP tool calls this month')", zaiRuns.some(run => run.startsWith('2 of 1000 MCP tool calls this month')), quote(zaiRuns))
  check('178x51 popup: the Kimi section keeps its own two bars', meterRuns(rawBlockRuns(popupRuns, 'Moonshot usage')).length === 2, quote(kimiPopupRuns))
  check('178x51 popup: no dated absence sentence and no unreported-credits line on the Z.AI section', !zaiRuns.some(run => /No Z\.AI usage read|checked 20|credits:/.test(run)), quote(zaiRuns))
  popupBoard.close()
  popup.closeSettingsPopup()

  await call('', {} as never)
  const narrowBoard = await world.mount(React.createElement(SettingsPopupSlot, { overlay: true }), NARROW)
  const narrowFrame = narrowBoard.frame()
  world.save('usage-popup', narrowFrame, NARROW)
  const narrowBox = popupFrameOf(narrowFrame)
  const narrowFaults = frameLaw(narrowFrame, NARROW)
  console.log(`80x21 popup frame: ${narrowBox === null ? '(none)' : `${narrowBox.right - narrowBox.left + 1}x${narrowBox.bottom - narrowBox.top + 1} at column ${narrowBox.left} row ${narrowBox.top}`} · faults ${JSON.stringify(narrowFaults)}`)
  check('80x21 popup: the stacked popup paints inside 80x21 without render errors, one provider per band', world.inBounds(narrowFrame, NARROW) && !narrowFrame.includes('RENDER ERROR') && narrowFrame.includes('Moonshot usage'), narrowFrame)
  check('80x21 popup: the stacked popup keeps the design — sized to the host (78 of 80, 19 of 21 rows), rounded, a blank gutter cell all round', narrowFaults.length === 0, narrowFaults.join(' · '))
  check('80x21 popup: the frame law refuses the frame on the host edge (the old 80-wide box at column 0)', narrowBox !== null && frameLaw(poisoned(narrowFrame, narrowBox, 'the frame on the host edge'), NARROW).length > 0)
  check("80x21 popup: the second band is Z.AI, named on the popup's more row until scrolled to", /↓ \d+ more · Z\.AI/.test(narrowFrame), narrowFrame)
  let presses = 0
  const rows = () => (popupFrameOf(narrowBoard.frame())?.rows ?? []).map(row => row.slice(1, -1).trim())
  while (presses < 24 && !(rows().includes('Z.AI usage') && rows().some(line => /^█+[▏▎▍▌▋▊▉]?$/u.test(line) && rows().indexOf(line) > rows().indexOf('Z.AI usage')))) {
    await narrowBoard.key('down')
    presses++
  }
  const scrolledFrame = narrowBoard.frame()
  const scrolledLines = rows()
  world.save('usage-popup-scrolled', scrolledFrame, NARROW)
  console.log(`80x21 popup after ${presses} ↓ presses: ${quote(scrolledLines.filter(line => line !== ''))}`)
  check(`80x21 popup, scrolled with ↓ (${presses} presses): the Z.AI section paints its plan slot and its 5h bar with the stated 17% inside 80x21`, world.inBounds(scrolledFrame, NARROW) && scrolledLines.includes('Z.AI usage') && scrolledLines.includes('GLM Coding Plan') && scrolledLines.some(line => line.startsWith('Window (5h) · 17%')) && scrolledLines.some(line => /^█+[▏▎▍▌▋▊▉]?$/u.test(line)), quote(scrolledLines.filter(line => line !== '')))
  narrowBoard.close()
  popup.closeSettingsPopup()
  const narrowPlan = railPlanAt(NARROW.columns, true)
  world.save('usage-card', narrowPlan.telemetry ? 'unexpected: a telemetry rail at 80 columns' : `no sidebar usage card at ${NARROW.columns}x${NARROW.rows}: the cockpit's telemetry rail needs both rails engaged (railPlanAt telemetry=false)`, NARROW)
  check('80x21: the cockpit has no telemetry rail at 80 columns (the card is a wide-cockpit surface)', narrowPlan.telemetry === false)

  const readerPath = world.path('src/services/providers/zai/zaiUsageState.ts')
  check('the Z.ai quota reader exists (the states below need it)', existsSync(readerPath), 'no such module on this tree')
  if (!existsSync(readerPath)) throw new Error('base tree: no reader')
  const zaiReader = await import(readerPath) as typeof import('../../src/services/providers/zai/zaiUsageState.js')
  zaiReader.__resetZaiUsageForTest()
  world.setNow(world.now() + 2_500)
  await board.repaint(card(WIDE.columns, WIDE.rows))
  const unreadRows = railBlock(board.runs(), 'zai')
  world.save('usage-card-glm-unread', board.frame(), WIDE)
  console.log(`rail GLM block before the first answer: ${quote(unreadRows)}`)
  check("178x51 rail, before the first answer: the GLM block says 'no usage read · /usage' (the rail's state · route idiom, whole at 28 cells) — one honest line, no bar, no fills-after-reply promise", unreadRows.includes(`${fresh.NO_USAGE_READ_WORDS} · /usage`) && !unreadRows.some(row => /fills after|[█░]{4}/.test(row)), quote(unreadRows))

  world.refuseQuota(true)
  await owner.refreshProviderUsage('zai', { fetchImpl: world.fetchImpl, now: world.now, force: true })
  world.setNow(world.now() + 2_500)
  await board.repaint(card(WIDE.columns, WIDE.rows))
  const refusedRows = railBlock(board.runs(), 'zai')
  world.save('usage-card-glm-refused', board.frame(), WIDE)
  console.log(`rail GLM block after a refused read: ${quote(refusedRows)}`)
  check("178x51 rail, a refused read with nothing observed: the reader's one line 'no usage read (HTTP 503)' and no bar", refusedRows.includes('no usage read (HTTP 503)') && !refusedRows.some(row => /[█░]{4}|fills after|· \/usage/.test(row)), quote(refusedRows))
  world.refuseQuota(false)

  zaiReader.__resetZaiUsageForTest()
  world.setQuotaBody({ code: 1234, msg: 'The current user has no coding plan', success: false })
  await owner.refreshProviderUsage('zai', { fetchImpl: world.fetchImpl, now: world.now, force: true })
  world.setNow(world.now() + 2_500)
  await board.repaint(card(WIDE.columns, WIDE.rows))
  const noPlanRows = railBlock(board.runs(), 'zai')
  world.save('usage-card-glm-no-plan', board.frame(), WIDE)
  console.log(`rail GLM block for a key with no coding plan: ${quote(noPlanRows)}`)
  check("178x51 rail, a key with no coding plan: its identity, the provider's absence and the owner's unreported credits, without a fabricated meter", noPlanRows[1] === 'Coding Plan key · …-key' && noPlanRows.slice(2).join(' ') === 'usage: not on a coding plan credits not reported' && !noPlanRows.some(row => /[█░]{4}|no usage read/.test(row)), quote(noPlanRows))
  world.setQuotaBody({ code: 200, msg: 'Operation successful', data: { limits: [world.glmFiveHour, world.glmWeek, world.glmTools], level: 'pro' }, success: true })

  zaiReader.__resetZaiUsageForTest()
  world.setQuotaAuth('bearer-only')
  const forms = world.quotaAuthForms.length
  await owner.refreshProviderUsage('zai', { fetchImpl: world.fetchImpl, now: () => world.observedAtMs, force: true })
  check('the header law on this wire: raw refused with 1001 ⇒ one Bearer retry, then confirmed', world.quotaAuthForms.slice(forms).join(',') === 'raw,bearer' && owner.usageForProvider('zai').windows.length === 2, JSON.stringify(world.quotaAuthForms.slice(forms)))
  world.setQuotaAuth('both')
  world.setNow(world.now() + 2_500)
  await board.repaint(card(WIDE.columns, WIDE.rows))
  check('the block paints its bars again after the confirmed retry', /5h [█░]{4} 17%/.test(board.frame()), quote(railBlock(board.runs(), 'zai')))

  world.setNow(world.observedAtMs + fresh.usageStaleAfterMs() + 60_000)
  await board.repaint(card(WIDE.columns, WIDE.rows))
  const staleRows = railBlock(board.runs(), 'zai')
  world.save('usage-card-glm-stale', board.frame(), WIDE)
  check('178x51 rail, a stale GLM observation keeps its bars and says stale in the one vocabulary', /5h [█░]{4} 17%/.test(board.frame()) && staleRows.join('').replace(/\s/g, '').includes(ageWords(fresh, owner.usageForProvider('zai').windows[0], world.now()).replace(/\s/g, '')), quote(staleRows))

  check('no fixture request escaped loopback', world.escaped.length === 0, JSON.stringify(world.escaped))
  board.close()
} catch (error) {
  if (!(error instanceof Error && error.message === 'base tree: no reader')) throw error
} finally {
  world.close()
}
finish()
