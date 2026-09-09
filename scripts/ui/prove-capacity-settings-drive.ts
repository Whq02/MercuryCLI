#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs, vshotBudgetScale } from '../lib/captureDriver.ts'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { gridToPng } from './gridToPng.ts'
import { STARTUP_MENU } from '../../src/substrate/startupMenu.ts'

const root = resolve(import.meta.dir, '..', '..')
const dist = join(root, 'dist', 'mercury.mjs')
const driver = resolveCaptureDriver()
if (!existsSync(dist)) throw new Error('Build the product before running the capacity settings journey')
if (driver.kind === 'unavailable') throw new Error(driver.reason + ': ' + driver.remedy)
if (driver.kind !== 'posix-pty') {
  console.log('The settings journey requires the POSIX capture driver; the capacity policy checks cover every platform.')
  process.exit(0)
}
const node = join(root, 'dist', 'vendor', 'node', 'bin', 'node')
const fixture = await startFixtureApi([])
const widths = process.argv.length > 2 ? process.argv.slice(2).map(Number) : [80, 120]
if (widths.some(width => width !== 80 && width !== 120)) throw new Error('Expected terminal widths of 80 or 120 columns')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ': ' + detail : ''}`)
}
const textOf = (mark: any): string => (mark?.grid ?? []).map((row: any[]) => row.map(cell => cell.c ?? ' ').join('')).join('\n')
try {
  for (const cols of widths) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'capacity-settings-home-')))
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'capacity-settings-project-')))
    seedFirstRun(home, [cwd])
    writeFileSync(join(cwd, 'sum.ts'), 'export const sum = (a: number, b: number) => a + b\n')
    const globalFile = join(home, '.mercury.json')
    const initial = JSON.parse(readFileSync(globalFile, 'utf8'))
    initial.switchboardCapacity = { askedAt: 1, allowed: false }
    initial.motion = 'off'
    writeFileSync(globalFile, JSON.stringify(initial))
    const output = join(home, 'capture.json')
    const config = join(home, 'capture-config.json')
    const sends = [
      { awaitText: 'New Session', requireAwait: true, awaitSettleTicks: 4, data: 'm' },
      { awaitText: STARTUP_MENU[0]!.label, requireAwait: true, awaitSettleTicks: 4, data: '\u001b[B'.repeat(STARTUP_MENU.length) },
      { awaitText: "· this machine's reading", requireAwait: true, awaitSettleTicks: 4, data: '\u001b[C', mark: 'menu-reading' },
      { awaitText: 'set by you', requireAwait: true, awaitSettleTicks: 4, data: '\u001b', mark: 'menu-raised' },
      { awaitText: 'New Session', requireAwait: true, awaitSettleTicks: 4, data: '\r' },
      { awaitText: 'type a prompt, or / for commands', requireAwait: true, awaitSettleTicks: 4, data: '/seats 9\r' },
      { awaitText: 'Seats set to 9', requireAwait: true, awaitSettleTicks: 4, data: '/config\r' },
      { awaitText: 'Auto-compact', requireAwait: true, awaitSettleTicks: 4, data: 'Seats' },
      { awaitText: '9 · set by you', requireAwait: true, awaitSettleTicks: 4, data: '\r', mark: 'config-reading' },
      { afterPrevTicks: 3, data: '\u001b[C' },
      { awaitText: '10 · set by you', requireAwait: true, awaitSettleTicks: 4, data: '\r', mark: 'config-raised' },
      { awaitText: 'type a prompt, or / for commands', requireAwait: true, awaitSettleTicks: 4, data: '/seats\r' },
      { awaitText: 'Seats: 10', requireAwait: true, awaitSettleTicks: 4, data: '', mark: 'confirmed' },
      { afterPrevTicks: 3, signal: 'SIGTERM', data: '', mark: 'exit' },
    ]
    writeFileSync(config, JSON.stringify({ argv: [node, dist, '--model', 'claude-fable-5-1'], cwd, cols, rows: 40, out: output, total: 600, sends }))
    const env = {
      HOME: home, PATH: `${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`, TERM: 'xterm-256color',
      MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_TEAMS_DIR: join(home, 'teams'),
      MERCURY_VSHOT_BUDGET_SCALE: String(vshotBudgetScale()), MERCURY_LOCAL_PROBE_TARGETS: 'none',
      ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: fixture.url,
    }
    console.log(`capture ${cols}: ${home}`)
    try {
      const result = await new Promise<{ code: number | null; text: string }>(resolveRun => {
        const child = spawn(driver.python, [captureEngineEntry(driver, root), config], { cwd: root, env })
        let text = ''
        child.stdout.on('data', value => { text += value })
        child.stderr.on('data', value => { text += value })
        const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(150000))
        child.on('close', code => { clearTimeout(deadline); resolveRun({ code, text }) })
      })
      check(`${cols}: the complete settings journey ran`, result.code === 0, result.text.trim().slice(-700))
      check(`${cols}: capture artifacts exist`, existsSync(output))
      if (!existsSync(output)) continue
      const capture = JSON.parse(readFileSync(output, 'utf8'))
      const marks = new Map<string, any>((capture.marks ?? []).map((mark: any) => [mark.label, mark]))
      check(`${cols}: every input reached its observed state`, capture.sendReceipts?.length === sends.length)
      const before = Number(/(\d+) · this machine's reading/.exec(textOf(marks.get('menu-reading')))?.[1])
      const raised = Number(/(\d+) · set by you/.exec(textOf(marks.get('menu-raised')))?.[1])
      check(`${cols}: the menu shows a measured reading and increments it`, Number.isFinite(before) && raised === before + 1)
      check(`${cols}: the populated settings view preserves and updates the ceiling`, textOf(marks.get('config-reading')).includes('9 · set by you') && textOf(marks.get('config-raised')).includes('10 · set by you'))
      check(`${cols}: the value is durable and the command agrees`, JSON.parse(readFileSync(globalFile, 'utf8')).switchboardCapacity?.operatorSeats === 10 && textOf(marks.get('confirmed')).includes('Seats: 10'))
      for (const label of ['menu-reading', 'config-raised']) {
        if (!marks.has(label)) continue
        const grid = join(home, `${label}.json`)
        const image = join(home, `${label}.png`)
        writeFileSync(grid, JSON.stringify(marks.get(label)))
        await gridToPng(grid, image)
        console.log(`frame ${cols} ${label}: ${image}`)
      }
    } finally {
      spawnSync(node, [dist, 'daemon', 'stop'], { env, timeout: 10000, stdio: 'pipe' })
    }
  }
  check('settings made no model call', fixture.messageRequests().length === 0)
} finally {
  await fixture.close()
}
process.exit(failures === 0 ? 0 : 1)
