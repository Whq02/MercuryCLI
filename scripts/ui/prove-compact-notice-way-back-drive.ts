#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, childEnv, DIST, endLeg, FACE_READY, finish, netlines, nonLoopback, printFrame, productNode, requireCaptureDriver, ROOT, scratch, startLeg } from '../computer/computerDriveKit.ts'
import { captureEngineEntry, vshotBudgetMs } from '../lib/captureDriver.ts'
import { keyHintLabel } from '../../src/components/mercury-ui/keyHintLabel.ts'
import { stringWidth } from '../../src/ink/stringWidth.ts'

type Cell = { c: string; fg: string; bg: string; bold: boolean; rev: boolean }
type Grid = Cell[][]
type Mark = { label: string; atTick: number; cols: number; rows: number; grid: Grid }
type Leg = Awaited<ReturnType<typeof startLeg>>

const driver = requireCaptureDriver('compact-notice-way-back')
const WAY_BACK = keyHintLabel('⇧← concourse')
const IDLE_COUNTS = '1 session on · 0 monitors here · 0 agents here'
const NOTICE_HEAD = 'Set model to'
const textRows = (grid: Grid): string[] => grid.map(row => row.map(c => c.c).join(''))
const trimmed = (rows: string[]): string[] => rows.map(r => r.replace(/\s+$/, ''))
const inkOf = (cells: Cell[]): string => cells.map(c => `${c.fg}/${c.bg}/${c.bold ? 1 : 0}`).join(' ')

async function capture(tag: string, cols: number, rows: number, wayBack: boolean): Promise<{ marks: Map<string, Mark>; status: number | null; log: string; leg: Leg }> {
  const leg = await startLeg(tag, [{ kind: 'text', text: 'Finished.' }], null)
  if (!wayBack) writeFileSync(join(leg.home, 'settings.json'), JSON.stringify({ compactWayBack: false }))
  const out = join(scratch, `${tag}.json`)
  const cfgPath = join(scratch, `${tag}-config.json`)
  const log = join(scratch, `${tag}-engine.log`)
  const sends = [
    { atTick: 40, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r', mark: 'boot' },
    { atTick: 999, awaitText: IDLE_COUNTS, minTick: 5, awaitSettleTicks: 4, awaitStableTicks: 3, requireAwait: true, data: '', mark: 'idle' },
    { afterPrevTicks: 1, data: '/model' },
    { afterPrevTicks: 2, data: '\r' },
    { atTick: 999, awaitText: 'esc close', minTick: 5, awaitSettleTicks: 3, requireAwait: true, data: '\u001b[A' },
    { afterPrevTicks: 3, data: '\r' },
    { atTick: 999, awaitText: NOTICE_HEAD, minTick: 3, awaitSettleTicks: 1, requireAwait: true, data: '', mark: 'notice' },
    { atTick: 999, awaitText: '0 agents here', minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '', mark: 'later' },
  ]
  writeFileSync(cfgPath, JSON.stringify({ argv: [productNode(), DIST], cwd: ROOT, cols, rows, sends, resizes: [], total: 320, out }))
  const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], { cwd: ROOT, env: childEnv(leg, { MERCURY_DESKTOP_DRIVER: 'none', MERCURY_CRITTER: 'clam' }), stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  const status = await new Promise<number | null>(resolve => {
    const wall = setTimeout(() => { output += '\ncapture deadline exceeded\n'; child.kill('SIGKILL') }, vshotBudgetMs(320 * 200 + 60_000))
    child.once('error', error => { output += `\n${String(error)}\n` })
    child.once('close', code => { clearTimeout(wall); resolve(code) })
  })
  writeFileSync(log, output)
  const marks = new Map<string, Mark>()
  if (existsSync(out)) {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { marks?: Mark[] }
    for (const mark of payload.marks ?? []) marks.set(mark.label, mark)
  }
  return { marks, status, log, leg }
}

console.log(`compact notice artifacts: ${scratch} (dist: ${DIST})`)

for (const [cols, rows] of [[80, 21], [80, 24]] as const) {
  const tag = `${cols}x${rows}`
  const on = await capture(`compact-notice-on-${tag}`, cols, rows, true)
  const off = await capture(`compact-notice-off-${tag}`, cols, rows, false)
  try {
    const landed = ['idle', 'notice', 'later'].every(label => on.marks.has(label) && off.marks.has(label))
    check(`${tag}: both boots painted the chat, the notice and its clearing (engine exit 0)`, on.status === 0 && off.status === 0 && landed, `on exit=${on.status} off exit=${off.status}; ${on.log} ${off.log}`)
    const onIdle = on.marks.get('idle')
    const onNotice = on.marks.get('notice')
    const onLater = on.marks.get('later')
    const offNotice = off.marks.get('notice')
    if (onIdle === undefined || onNotice === undefined || onLater === undefined || offNotice === undefined) continue
    const onRows = textRows(onNotice.grid)
    const offRows = textRows(offNotice.grid)
    printFrame(`${tag} the way back stays`, trimmed(onRows))
    printFrame(`${tag} the setting off (the shipped row)`, trimmed(offRows))
    const last = rows - 1
    const onRow = onRows[last] ?? ''
    const offRow = offRows[last] ?? ''
    const keep = cols - 2 - stringWidth(WAY_BACK)
    check(`${tag}: the notice leads the bottom row in both states`, onRow.startsWith(NOTICE_HEAD) && offRow.startsWith(NOTICE_HEAD), `${JSON.stringify(onRow)} / ${JSON.stringify(offRow)}`)
    check(`${tag}: with the setting off the notice takes the whole row, cut at the width with an ellipsis and no way back`, offRow.length === cols && offRow.endsWith('…') && !offRow.includes(WAY_BACK), JSON.stringify(offRow))
    check(
      `${tag}: with the way back kept, the row is the notice cut to ${keep} columns with an ellipsis, two blank columns, then the way back at the row's right end`,
      onRow.length === cols && onRow.slice(0, keep - 1) === offRow.slice(0, keep - 1) && onRow[keep - 1] === '…' && onRow.slice(keep, keep + 2) === '  ' && onRow.slice(keep + 2) === WAY_BACK,
      JSON.stringify(onRow),
    )
    const hintAt = cols - stringWidth(WAY_BACK)
    check(`${tag}: the way back wears the ink the idle row paints it in`, inkOf((onNotice.grid[last] ?? []).slice(hintAt)) === inkOf((onIdle.grid[last] ?? []).slice(hintAt)), inkOf((onNotice.grid[last] ?? []).slice(hintAt)))
    check(`${tag}: the notice wears the ink the counts wear`, inkOf((onNotice.grid[last] ?? []).slice(0, 1)) === inkOf((onIdle.grid[last] ?? []).slice(0, 1)), inkOf((onNotice.grid[last] ?? []).slice(0, 1)))
    check(`${tag}: every row above the bottom row is the same in both states`, onRows.slice(0, last).join('|') === offRows.slice(0, last).join('|'), trimmed(onRows).filter((r, i) => r !== (offRows[i] ?? '').replace(/\s+$/, '')).slice(0, 3).join(' | '))
    const laterRow = textRows(onLater.grid)[last] ?? ''
    check(`${tag}: the counts return beside the way back when the notice clears`, laterRow.startsWith(IDLE_COUNTS) && laterRow.trimEnd().endsWith(WAY_BACK) && !laterRow.includes(NOTICE_HEAD), JSON.stringify(laterRow.trimEnd()))
    check(`${tag}: the drives stayed on loopback`, nonLoopback(netlines(on.leg.netlog)).length === 0 && nonLoopback(netlines(off.leg.netlog)).length === 0)
  } finally {
    await endLeg(on.leg)
    await endLeg(off.leg)
  }
}

finish('compact-notice-way-back')
