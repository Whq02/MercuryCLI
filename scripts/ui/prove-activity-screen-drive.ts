#!/usr/bin/env bun
// gate-watch: src/components/tasks/BackgroundTasksDialog.tsx src/components/mercury-ui/components.tsx src/components/mercury-ui/useCursorFollow.ts src/components/FullscreenLayout.tsx src/screens/Chat.tsx
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ADMITTED, check, childEnv, DIST, endLeg, FACE_READY, finish, printFrame, productNode, requireCaptureDriver, ROOT, scratch, startLeg,
} from '../computer/computerDriveKit.ts'
import { captureEngineEntry, vshotBudgetMs } from '../lib/captureDriver.ts'

const driver = requireCaptureDriver('activity-screen-drive')
const DONE = 'activity-drive: six watches are running'
const MONITORS = 6
const SIZES: Array<[number, number]> = [[80, 24], [64, 20]]
type Mark = { label: string; grid: Array<Array<{ c: string }>> }
const rowsOf = (grid: Array<Array<{ c: string }>>): string[] => grid.map(row => row.map(cell => cell.c).join('').replace(/\s+$/, ''))
const cursorRow = (rows: string[]): number => rows.findIndex(row => /^❯ /.test(row))
const monitorRows = (rows: string[]): number[] => rows.map((row, index) => (/^[ ❯] [◐○●✕✓] sleep 600/.test(row) ? index : -1)).filter(index => index >= 0)
const monitorsHeader = (rows: string[]): number => rows.findIndex(row => row.startsWith(`Monitors (${MONITORS})`))
const hintRow = (rows: string[]): number => rows.findIndex(row => row.includes('↑/↓ select') && row.includes('esc close'))

for (const [cols, rows] of SIZES) {
  const tag = `activity-screen-${cols}x${rows}`
  const leg = await startLeg(tag, [
    { kind: 'paced_tool_use', preDeltas: ['starting the watches'], gapMs: 50, tools: Array.from({ length: MONITORS }, (_, index) => ({ name: 'Monitor', input: { description: `watch ${index + 1} of the build log`, command: 'sleep 600', persistent: true } })) },
    { kind: 'text', text: DONE },
  ], null)
  writeFileSync(join(leg.home, 'settings.json'), JSON.stringify({ guardrails: { sovereignConsentSeen: true }, activity: { tips: { enabled: false } } }))
  const out = join(scratch, `${tag}.json`)
  const cfgPath = join(scratch, `${tag}-config.json`)
  const sends = [
    { requireAwait: true, awaitText: FACE_READY, awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, awaitText: ADMITTED, awaitSettleTicks: 2, data: 'start six watches\r' },
    { requireAwait: true, awaitText: DONE, awaitSettleTicks: 3, data: '', mark: 'turn-done' },
    { afterPrevTicks: 4, data: '\u0014' },
    { afterPrevTicks: 4, data: '\r' },
    { requireAwait: true, awaitText: 'activity · 6 active', data: '' },
    { afterPrevTicks: 6, data: '', mark: 'open' },
    { afterPrevTicks: 3, data: '\u001b[B' },
    { afterPrevTicks: 3, data: '\u001b[B' },
    { afterPrevTicks: 3, data: '\u001b[B' },
    { afterPrevTicks: 6, data: '', mark: 'down-3' },
    { afterPrevTicks: 3, data: '\u001b[B' },
    { afterPrevTicks: 3, data: '\u001b[B' },
    { afterPrevTicks: 3, data: '\u001b[B' },
    { afterPrevTicks: 3, data: '\u001b[B' },
    { afterPrevTicks: 6, data: '', mark: 'end' },
    { afterPrevTicks: 3, data: '\u001b[A' },
    { afterPrevTicks: 3, data: '\u001b[A' },
    { afterPrevTicks: 6, data: '', mark: 'up-2' },
    { afterPrevTicks: 3, data: '\u001b[<65;10;10M' },
    { afterPrevTicks: 6, data: '', mark: 'wheel' },
    { afterPrevTicks: 3, data: '\u001b' },
    { afterPrevTicks: 6, data: '', mark: 'closed' },
  ]
  writeFileSync(cfgPath, JSON.stringify({ argv: [productNode(), DIST, '--chat', '--sovereign'], cwd: ROOT, cols, rows, sends, resizes: [], total: 400, out }))
  const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], { cwd: ROOT, env: childEnv(leg, { MERCURY_DESKTOP_DRIVER: 'none', FORCE_COLOR: '3' }), stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  const status = await new Promise<number | null>(resolve => {
    const wall = setTimeout(() => { output += '\ncapture deadline exceeded\n'; child.kill('SIGKILL') }, vshotBudgetMs(400 * 200 + 60_000))
    child.once('close', code => { clearTimeout(wall); resolve(code) })
  })
  try {
    check(`${tag}: the drive ran to its end`, status === 0 && existsSync(out), `exit=${status}; ${output.slice(-600)}`)
    if (!existsSync(out)) continue
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { marks?: Mark[] }
    const marks = new Map((payload.marks ?? []).map(mark => [mark.label, rowsOf(mark.grid)]))
    const at = (label: string): string[] => marks.get(label) ?? []
    for (const label of ['open', 'down-3', 'end', 'up-2', 'wheel', 'closed']) printFrame(`${tag} ${label}`, at(label))
    const open = at('open')
    check(`${tag}: the activity screen opened with the six monitors counted`, open.some(row => row.includes('activity · 6 active')) && open.some(row => row.includes('6 monitors here')), open.slice(0, 4).join(' | '))
    check(`${tag}: the selected monitor row is painted on open`, cursorRow(open) >= 0 && monitorRows(open).includes(cursorRow(open)), `cursor row ${cursorRow(open)} · monitor rows ${monitorRows(open).join(',')}`)
    const down = at('down-3')
    const downMonitors = monitorRows(down)
    check(`${tag}: ↓ ×3 moves the cursor to the fourth monitor and keeps it painted`, cursorRow(down) >= 0 && downMonitors.indexOf(cursorRow(down)) >= 0 && (monitorsHeader(down) < 0 ? downMonitors.indexOf(cursorRow(down)) <= 3 : downMonitors.indexOf(cursorRow(down)) === 3 || cursorRow(down) - monitorsHeader(down) === 4), `cursor row ${cursorRow(down)} · monitor rows ${downMonitors.join(',')} · header ${monitorsHeader(down)}`)
    const end = at('end')
    check(`${tag}: ↓ past the last monitor keeps the cursor on it and reaches the list's own hint row`, cursorRow(end) >= 0 && hintRow(end) > cursorRow(end), `cursor row ${cursorRow(end)} · hint row ${hintRow(end)}`)
    const up = at('up-2')
    check(`${tag}: ↑ ×2 walks back two rows and the cursor stays painted`, cursorRow(up) >= 0 && monitorRows(up).includes(cursorRow(up)), `cursor row ${cursorRow(up)} · monitor rows ${monitorRows(up).join(',')}`)
    const wheel = at('wheel')
    check(`${tag}: the wheel scrolls the panel without moving the selection`, cursorRow(wheel) < 0 || monitorRows(wheel).includes(cursorRow(wheel)), `cursor row ${cursorRow(wheel)}`)
    const closed = at('closed')
    check(`${tag}: esc closes the screen and the composer is back`, closed.some(row => row.includes('Type a prompt')) && !closed.some(row => row.includes('Session statistics')), closed.slice(-4).join(' | '))
  } finally {
    await endLeg(leg)
  }
}
finish('activity-screen-drive')
