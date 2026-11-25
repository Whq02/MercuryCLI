#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs, vshotBudgetScale } from '../lib/captureDriver.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const root = resolve(import.meta.dir, '..', '..')
const SPLASH = join(root, 'assets', 'splash', 'mercury-splash.mjs')
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') throw new Error(driver.reason + ': ' + driver.remedy)
if (driver.kind !== 'posix-pty') {
  console.log('The splash resize drive requires the POSIX capture driver.')
  process.exit(0)
}
let failures = 0
const check = (label: string, ok: boolean, fix: string): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ': ' + fix}`)
}
type Grid = Array<Array<{ c?: string }>>
const textOf = (grid: Grid | undefined): string => (grid ?? []).map(row => row.map(cell => cell.c ?? ' ').join('').trimEnd()).join('\n')
const caretRow = (frame: string): string => frame.split('\n').find(line => line.includes('❯'))?.trim() ?? 'no caret'
const FIX = 'where the launcher splash handles a resize (out.on(\'resize\') in assets/splash/mercury-splash.mjs) the selection must be clamped to the rows shownCardRows answers for the new size'

const home = realpathSync(mkdtempSync(join(tmpdir(), 'splash-resize-home-')))
const output = join(home, 'capture.json')
const config = join(home, 'capture-config.json')
const step = (awaitText: string, awaitPattern: string, data: string, mark: string) => ({ awaitText, awaitPattern, requireAwait: true, awaitSettleTicks: 3, data, mark })
const sends = [
  step('Profiles', 'Boot Menu', '\u001b[A', 'five'),
  step('Profiles', '❯.*Profiles', '', 'selected'),
  step('Boot Menu', '❯.*Boot Menu', '\r', 'clamped'),
]
writeFileSync(config, JSON.stringify({ argv: ['node', SPLASH], cwd: home, cols: 100, rows: 19, out: output, total: 300, sends, resizes: [{ afterMark: 'selected', afterMs: 400, cols: 100, rows: 18 }], readyText: 'boot menu' }))
const env = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: home,
  TERM: 'xterm-256color',
  NO_COLOR: '1',
  MERCURY_HOME: home,
  MERCURY_CONFIG_DIR: home,
  MERCURY_SPLASH_VIEW: 'lockup',
  MERCURY_VSHOT_BUDGET_SCALE: String(vshotBudgetScale()),
}
const result = await new Promise<{ code: number | null; text: string }>(resolveRun => {
  const child = spawn(driver.python, [captureEngineEntry(driver, root), config], { cwd: root, env })
  let text = ''
  child.stdout.on('data', value => { text += value })
  child.stderr.on('data', value => { text += value })
  const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(90000))
  child.on('close', code => { clearTimeout(deadline); resolveRun({ code, text }) })
})
const capture = (existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : {}) as { grid?: Grid; marks?: Array<{ label: string; grid: Grid }>; sendReceipts?: unknown[] }
removeScratch(home)
const marks = new Map((capture.marks ?? []).map(mark => [mark.label, textOf(mark.grid)]))
check('at 100 by 19 a fresh home\'s card shows five rows, Profiles last, and ↑ from the first row selects it', (marks.get('selected') ?? '').includes('Profiles') && caretRow(marks.get('selected') ?? '').includes('Profiles'), `the caret stands on: ${caretRow(marks.get('selected') ?? '')}`)
check('resized to 18 rows the card shows four rows and the caret stands on Boot Menu, the last row shown', !(marks.get('clamped') ?? '').includes('Profiles') && caretRow(marks.get('clamped') ?? '').includes('Boot Menu'), `${FIX}; the caret stands on: ${caretRow(marks.get('clamped') ?? '')}`)
check('↵ then opens the row the caret is on: the boot menu, and the splash did not stop on an error', result.code === 0 && capture.sendReceipts?.length === sends.length && textOf(capture.grid).includes('boot menu') && !result.text.includes('TypeError'), `${FIX}. ${result.text.trim().slice(-400)}`)
process.exit(failures === 0 ? 0 : 1)
