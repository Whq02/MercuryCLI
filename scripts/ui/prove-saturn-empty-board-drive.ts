#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs, vshotBudgetScale } from '../lib/captureDriver.ts'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { BOOT_FACE_READY } from '../lib/bootFace.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const framesDir = process.argv[2]
const PAGE = 'src/screen/boot-face/saturn/menu.tsx'
const LAYOUT = 'composeBootMenuClassic in assets/splash/splash-core.mjs'
const DEAD = 'http://127.0.0.1:1'
const LEGEND = 'a schedule birth…'
const CLASSIC_TITLE = 'MERCURY · saturn scheduler'
const WORDS = [
  'no schedules stand.',
  'press a to schedule a session birth — a fresh session born on the clock.',
  'a session schedules itself too (its own tools, the set-schedule door); every schedule and its fire decisions land here.',
]

const driver = resolveCaptureDriver()
if (!existsSync(DIST)) throw new Error('Build the product (bun run build.ts) before running the Saturn empty board drive')
if (driver.kind === 'unavailable') throw new Error(driver.reason + ': ' + driver.remedy)
if (driver.kind !== 'posix-pty') {
  console.log('The Saturn empty board drive requires the POSIX capture driver.')
  process.exit(0)
}
const python = driver.python
const engine = captureEngineEntry(driver, ROOT)
const vendoredNode = join(ROOT, 'dist', 'vendor', 'node', 'bin', 'node')
const node = existsSync(vendoredNode) ? vendoredNode : Bun.which('node') ?? 'node'
const fixture = await startFixtureApi([])

let failures = 0
const check = (label: string, ok: boolean, fix: string): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ': ' + fix}`)
}
const squash = (text: string): string => text.replace(/\s+/g, '')
const inOrder = (text: string, words: readonly string[]): boolean => {
  let at = 0
  for (const w of words) {
    const found = text.indexOf(squash(w), at)
    if (found < 0) return false
    at = found + squash(w).length
  }
  return true
}
const countOf = (text: string, word: string): number => text.split(squash(word)).length - 1
const shown = (rows: readonly string[]): string => rows.map(r => r.trimEnd()).filter(r => r.trim() !== '').map(r => r.trim()).join(' | ')

type Send = { awaitText: string; requireAwait: true; awaitSettleTicks: number; data: string; awaitPattern?: string; mark?: string }
type Grid = Array<Array<{ c?: string }>>
const textOf = (grid: Grid | undefined): string[] => (grid ?? []).map(row => row.map(cell => cell.c ?? ' ').join(''))

const toTheChat: Send[] = [
  { awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, requireAwait: true, awaitSettleTicks: 2, data: '\r' },
  { awaitText: 'Type a prompt', requireAwait: true, awaitSettleTicks: 2, data: '/saturn' },
  { awaitText: 'Schedules — next fire', requireAwait: true, awaitSettleTicks: 2, data: '\r' },
  { awaitText: LEGEND, requireAwait: true, awaitSettleTicks: 4, data: '', mark: 'saturn' },
]
const onTheFace: Send[] = [{ awaitText: LEGEND, requireAwait: true, awaitSettleTicks: 4, data: '', mark: 'saturn' }]

async function capture(cols: number, rows: number, scene: { name: string; door: boolean }): Promise<string[]> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'saturn-empty-')))
  const home = join(scratch, 'home')
  const cwd = join(scratch, 'project')
  mkdirSync(cwd)
  seedFirstRun(home, [cwd])
  if (scene.door) writeFileSync(join(home, 'splash-action.json'), JSON.stringify({ version: 1, ts: Date.now(), action: 'saturn' }))
  const sends = scene.door ? onTheFace : toTheChat
  const output = join(home, 'capture.json')
  const config = join(home, 'capture-config.json')
  writeFileSync(config, JSON.stringify({ argv: [node, DIST], cwd, cols, rows, out: output, total: 600, sends, readyText: [LEGEND] }))
  const env = {
    HOME: home,
    PATH: `${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TERM: 'xterm-256color',
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_UPDATE_API_BASE_URL: DEAD,
    MERCURY_VSHOT_BUDGET_SCALE: String(vshotBudgetScale()),
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    ANTHROPIC_BASE_URL: fixture.url,
    ...(scene.door ? { MERCURY_SPLASH_HANDOFF: '1' } : {}),
  }
  try {
    const result = await new Promise<{ code: number | null; text: string }>(resolveRun => {
      const child = spawn(python, [engine, config], { cwd: ROOT, env })
      let text = ''
      child.stdout.on('data', value => { text += value })
      child.stderr.on('data', value => { text += value })
      const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(150000))
      child.on('close', code => { clearTimeout(deadline); resolveRun({ code, text }) })
    })
    const captured = (existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : {}) as { marks?: Array<{ label: string; grid: Grid }>; sendReceipts?: unknown[] }
    check(`${cols}x${rows} ${scene.name}: the drive reached the Saturn page`, result.code === 0 && captured.sendReceipts?.length === sends.length, `an awaited text never painted (${scene.door ? 'the splash receipt opens the page on the face' : '/saturn typed in a new chat'}); the output tail reads: ${result.text.trim().slice(-700)}`)
    const grid = captured.marks?.find(m => m.label === 'saturn')?.grid
    const frame = textOf(grid)
    if (framesDir !== undefined) {
      mkdirSync(framesDir, { recursive: true })
      writeFileSync(join(framesDir, `${scene.name}-${cols}x${rows}.txt`), frame.map(r => r.trimEnd()).join('\n') + '\n')
      writeFileSync(join(framesDir, `${scene.name}-${cols}x${rows}.grid.json`), JSON.stringify(grid ?? []) + '\n')
    }
    return frame
  } finally {
    spawnSync(node, [DIST, 'daemon', 'stop'], { env, timeout: 10000, stdio: 'pipe' })
    removeScratch(scratch)
  }
}

const POPUP_TITLE = 'Mercury — saturn'

function pageOf(frame: readonly string[], titleNeedle: string): string[] {
  const title = frame.findIndex(r => r.includes(titleNeedle))
  const legend = frame.findIndex((r, i) => i > title && r.includes(LEGEND))
  if (title < 0 || legend < 0) return []
  const slice = frame.slice(title, legend + 2)
  const left = frame[title]!.lastIndexOf('│', frame[title]!.indexOf(titleNeedle))
  const right = left >= 0 ? frame[title]!.indexOf('│', frame[title]!.indexOf(titleNeedle) + titleNeedle.length) : -1
  return left >= 0 && right > left ? slice.map(r => r.slice(left + 1, right)) : slice
}

try {
  for (const [cols, rows, name, door] of [[120, 40, 'chat', false], [100, 30, 'chat', false], [80, 24, 'chat', false], [100, 30, 'face', true], [80, 24, 'face', true]] as const) {
    const frame = await capture(cols, rows, { name, door })
    const titleNeedle = door ? CLASSIC_TITLE : POPUP_TITLE
    const page = pageOf(frame, titleNeedle)
    console.log(`[record] ${cols}x${rows} ${name}: ${shown(page)}`)
    check(
      door
        ? `${cols}x${rows} ${name}: the page opens in the classic layout (its title row and its legend)`
        : `${cols}x${rows} ${name}: /saturn opens in the pop-up (its title row and its legend, no (>_) classic banner)`,
      page.length > 0 && (door || !frame.some(r => r.includes('(>_)'))),
      `the title row "${titleNeedle}" and the legend must both paint; the frame reads: ${shown(frame).slice(0, 600)}`,
    )
    check(`${cols}x${rows} ${name}: with no schedules, the empty board's words stand between the title and the legend, whole and in order`, inOrder(squash(page.join('\n')), WORDS), `the empty board must paint its words from saturnEmptyDetailLines between title and legend (${PAGE} / src/commands/saturn/saturn.tsx); the page reads: ${shown(page)}`)
  }
  for (const [cols, rows] of [[120, 40], [120, 47]] as const) {
    const frame = await capture(cols, rows, { name: 'wide', door: true })
    const at = frame.findIndex(r => r.includes(WORDS[0]!))
    const col = at < 0 ? -1 : frame[at]!.indexOf(WORDS[0]!)
    const pane = at < 0 ? [] : frame.slice(at).map(r => r.slice(col))
    const facts = pane.findIndex(r => /^Schedules\s+0\b/.test(r))
    console.log(`[record] ${cols}x${rows} wide: ${shown(frame)}`)
    check(`${cols}x${rows} wide: the words stand once, in the detail pane beside the empty list box`, at >= 0 && /╭─+╮\s+$/.test(frame[at]!.slice(0, col)) && countOf(squash(frame.join('\n')), WORDS[0]!) === 1 && inOrder(squash(pane.join('\n')), WORDS) && !frame.some(r => r.includes(CLASSIC_TITLE)), `the wide layout draws the board's detail pane right of the list box, and nothing else of it (composeBootMenuWide in assets/splash/splash-core.mjs reads detailOverride, never noticeLine); the frame reads: ${shown(frame).slice(0, 900)}`)
    check(`${cols}x${rows} wide: the facts block, the status line and the legend keep their places under the pane`, facts > 0 && /^Next fire\s+—/.test(pane[facts + 1] ?? '') && /^Held\s+0\b/.test(pane[facts + 2] ?? '') && /^Sessions\s+\d+ live\b/.test(pane[facts + 3] ?? '') && frame.some(r => /^\s+no (schedules on \d+ live sessions?|live sessions hold schedules)\s*$/.test(r)) && frame.some(r => r.includes(LEGEND)), `the summary rows (saturnSummaryRows) and the status line (saturnStatusLine) of src/screen/boot-face/BootSaturnScreen.tsx keep their places in the wide layout; the pane reads: ${shown(pane)}`)
  }
  check('the Saturn page made no model call', fixture.messageRequests().length === 0, 'opening /saturn and the face door must stay on the page; a key reached the model API')
} finally {
  await fixture.close()
}
process.exit(failures === 0 ? 0 : 1)
