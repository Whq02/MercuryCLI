#!/usr/bin/env bun
// gate-watch: src/components/ScrollKeybindingHandler.tsx src/components/CustomSelect/use-select-input.ts src/components/HelpV2/Commands.tsx src/commands/health/HealthCertificate.tsx
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ADMITTED, check, childEnv, DIST, endLeg, FACE_READY, finish, printFrame, productNode, requireCaptureDriver, ROOT, scratch, section, startLeg,
} from '../computer/computerDriveKit.ts'
import { captureEngineEntry, vshotBudgetMs } from '../lib/captureDriver.ts'

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const frameDir = arg('--frames')
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
const PAGE_DOWN = '\x1b[6~'
const PAGE_UP = '\x1b[5~'
const DOWN = '\x1b[B'
const RIGHT = '\x1b[C'
const ESC = '\x1b'
const gate = { requireAwait: true, minTick: 2, awaitSettleTicks: 3 }
type Grid = Array<Array<{ c: string }>>
const rowsOf = (g: Grid): string[] => g.map(r => r.map(c => c.c).join('').replace(/\s+$/, ''))

const driver = requireCaptureDriver('popup-page-keys')
const cwd = join(scratch, 'popup-page-keys-cwd')
mkdirSync(cwd, { recursive: true })
const leg = await startLeg('popup-page-keys', [{ kind: 'text', text: 'Finished.' }], null, cwd)
try {
  const grid = join(scratch, 'popup-page-keys-grid.json')
  const cfgPath = join(scratch, 'popup-page-keys-vshot.json')
  const sends = [
    { ...gate, awaitText: FACE_READY, awaitSettleTicks: 2, data: '\r', mark: 'boot' },
    { ...gate, awaitText: ADMITTED, awaitSettleTicks: 6, data: '/help' },
    { ...gate, awaitText: '❯ /help', awaitStableTicks: 2, data: '\r' },
    { ...gate, awaitText: 'custom-commands', awaitStableTicks: 3, data: RIGHT },
    { ...gate, awaitText: 'Browse default commands', awaitSettleTicks: 3, data: DOWN },
    { ...gate, awaitText: '❯ /', awaitSettleTicks: 3, data: '', mark: 'help-list' },
    { ...gate, awaitText: '❯ /', data: PAGE_DOWN },
    { ...gate, awaitText: '❯ /', awaitSettleTicks: 4, data: '', mark: 'help-page-down' },
    { ...gate, awaitText: '❯ /', data: PAGE_UP },
    { ...gate, awaitText: '❯ /', awaitSettleTicks: 4, data: '', mark: 'help-page-up' },
    { ...gate, awaitText: '❯ /', data: ESC },
    { ...gate, awaitText: 'Type a prompt', awaitPattern: '\\A(?![\\s\\S]*custom-commands)', awaitSettleTicks: 3, data: '/health' },
    { ...gate, awaitText: '❯ /health', awaitStableTicks: 2, data: '\r' },
    { ...gate, awaitText: '⇞⇟ page', awaitPattern: '· 1/\\d+', awaitSettleTicks: 4, data: '', mark: 'health' },
    { ...gate, awaitText: '⇞⇟ page', data: PAGE_DOWN },
    { ...gate, awaitText: '⇞⇟ page', awaitSettleTicks: 4, data: '', mark: 'health-page-down' },
  ]
  writeFileSync(cfgPath, JSON.stringify({ argv: [productNode(), DIST], cwd, cols: 120, rows: 40, sends, resizes: [], readyText: '⇞⇟ page', readySettleTicks: 3, total: 400, out: grid }))
  const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], { cwd: ROOT, env: childEnv(leg, { MERCURY_DESKTOP_DRIVER: 'none', MERCURY_SPLASH: 'off', MERCURY_REDUCED_MOTION: '1' }), stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stdout.on('data', chunk => { stderr += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const status = await new Promise<number | null>(resolve => {
    const wall = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(400 * 200 + 60_000))
    child.once('error', () => { clearTimeout(wall); resolve(null) })
    child.once('exit', code => { clearTimeout(wall); resolve(code) })
  })
  const payload = existsSync(grid) ? JSON.parse(readFileSync(grid, 'utf8')) as { marks?: Array<{ label: string; grid: Grid }>; endReason?: string } : null
  const marks = new Map((payload?.marks ?? []).map(m => [m.label, rowsOf(m.grid)]))
  for (const [label, rows] of marks) {
    if (frameDir !== undefined) writeFileSync(join(frameDir, `popup-page-keys-${label}.txt`), rows.join('\n') + '\n')
  }
  const caretCommand = (rows: string[]): string | null => {
    const row = rows.find(r => /│ ❯ \/\S+/.test(r))
    return row === null || row === undefined ? null : /❯ (\/\S+)/.exec(row)?.[1] ?? null
  }
  const listIndex = (rows: string[], name: string | null): number => (name === null ? -1 : rows.findIndex(r => r.includes(` ${name}`)))
  const counter = (rows: string[]): number | null => {
    const row = rows.find(r => /⇞⇟ page/.test(r))
    const m = row === undefined ? null : /· (\d+)\/(\d+)/.exec(row)
    return m === null ? null : Number(m[1])
  }

  section('/help · commands — PageDown pages the list, PageUp pages it back')
  const list = marks.get('help-list') ?? []
  const down = marks.get('help-page-down') ?? []
  const up = marks.get('help-page-up') ?? []
  printFrame('/help commands after ↓', list.slice(10, 36))
  printFrame('/help commands after PageDown', down.slice(10, 36))
  check('the drive reached every surface', status === 0 && payload?.endReason === 'ready', `status ${status} end ${payload?.endReason} ${stderr.slice(-400)}`)
  const before = caretCommand(list)
  const after = caretCommand(down)
  const back = caretCommand(up)
  check('↓ focuses the list on its first command', before !== null, list.filter(r => r.includes('❯')).join(' | '))
  check('PageDown moves the caret onto a later command', after !== null && before !== null && after !== before && listIndex(down, after) > listIndex(list, before), `before ${before} after ${after}`)
  check('PageUp brings the caret back to the first command', back === before, `back ${back} first ${before}`)

  section('/health — PageDown pages the cursor over the check rows')
  const health = marks.get('health') ?? []
  const healthDown = marks.get('health-page-down') ?? []
  printFrame('/health footer before and after PageDown', [health.find(r => /⇞⇟ page/.test(r)) ?? '', healthDown.find(r => /⇞⇟ page/.test(r)) ?? ''])
  const c0 = counter(health)
  const c1 = counter(healthDown)
  check('/health opened with its cursor on the first check', c0 === 1, `counter ${c0}`)
  check('PageDown moves the cursor a page down (the footer counter jumps by more than one)', c0 !== null && c1 !== null && c1 - c0 > 1, `before ${c0} after ${c1}`)
} finally {
  await endLeg(leg)
}
finish('popup-page-keys')
