import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BOOT_FACE_READY } from '../lib/bootFace.ts'
import { captureEngineEntry, vshotBudgetMs, type AvailableCaptureDriver } from '../lib/captureDriver.ts'
import { readTeeFrames } from './appleTerminalReading.ts'
import { fixture, ROOT } from './viewportFixture.ts'

type Cell = { c: string; fg: string; bg: string; bold: boolean; rev: boolean }
export type Grid = Cell[][]
type Journey = { name: string; marks: Map<string, Grid>; bytes: Uint8Array; status: number | null; log: string }

export const JOURNEY_MARKS = ['theme', 'boot', 'session'] as const
export const DIST = join(ROOT, 'dist', 'mercury.mjs')

const BLOCKS = new Set(['█', '▀', '▄', '▌', '▐'])

export const isHexInk = (ink: string): boolean => /^[0-9a-f]{6}$/.test(ink)
export const isGreyInk = (ink: string): boolean => isHexInk(ink) && ink.slice(0, 2) === ink.slice(2, 4) && ink.slice(2, 4) === ink.slice(4, 6)
export const inkOf = (color: string): string => color.replace('#', '').toLowerCase()
export const isBlock = (cell: Cell): boolean => BLOCKS.has(cell.c)

export function basicColourCodes(bytes: Uint8Array): number {
  let count = 0
  for (const match of Buffer.from(bytes).toString('latin1').matchAll(/\x1b\[([0-9;]*)m/g)) {
    const params = (match[1] ?? '').split(';').map(Number)
    for (let i = 0; i < params.length; i++) {
      const p = params[i]!
      if (p === 38 || p === 48) i += params[i + 1] === 2 ? 4 : 2
      else if ((p >= 30 && p <= 37) || (p >= 40 && p <= 47) || (p >= 90 && p <= 97) || (p >= 100 && p <= 107)) count++
    }
  }
  return count
}

export function artRows(grid: Grid): { critter: number[]; wordmark: number[] } {
  const rule = grid.findIndex(row => row.filter(cell => cell.c === '─').length >= 20 && !row.some(cell => cell.c === '╭' || cell.c === '╰'))
  const rows = grid.map((row, y) => (row.filter(isBlock).length >= 3 ? y : -1)).filter(y => y >= 0)
  return { critter: rows.filter(y => y < rule), wordmark: rows.filter(y => y > rule) }
}

export async function colourDepthJourney(driver: AvailableCaptureDriver, scratch: string, name: string, extra: Record<string, string | undefined>): Promise<Journey> {
  const node = Bun.which('node')
  if (!node) throw new Error('node is required')
  const world = fixture(scratch)
  const cfgPath = join(world.config, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  cfg.hasCompletedOnboarding = false
  cfg.optionAsMetaKeyInstalled = true
  writeFileSync(cfgPath, JSON.stringify(cfg))
  writeFileSync(join(world.config, 'settings.json'), JSON.stringify({ view: { reducedMotion: true } }))
  const env: NodeJS.ProcessEnv = { ...world.env }
  delete env.COLORTERM
  delete env.FORCE_COLOR
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  const tee = join(scratch, `${name}.tee.bin`)
  env.VSHOT_TEE = tee
  const out = join(scratch, `${name}.json`)
  const gate = { requireAwait: true, minTick: 3, awaitSettleTicks: 5 }
  const sends = [
    { ...gate, awaitText: '↑↓ preview', data: '', mark: 'theme' },
    { ...gate, awaitText: '↑↓ preview', data: '\r' },
    { ...gate, awaitText: '↵ continue', data: '\r' },
    { ...gate, awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, data: '', mark: 'boot' },
    { ...gate, awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, data: '\r' },
    { ...gate, awaitText: 'Type a prompt', awaitSettleTicks: 12, data: '', mark: 'session' },
  ]
  const cfgFile = join(scratch, `${name}.capture.json`)
  writeFileSync(cfgFile, JSON.stringify({ argv: [node, DIST], cwd: world.cwd, cols: 120, rows: 40, total: 450, sends, readyText: 'Type a prompt', readySettleTicks: 3, out }))
  const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), cfgFile], { cwd: world.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', bytes => { log += String(bytes) })
  child.stderr.on('data', bytes => { log += String(bytes) })
  const status = await new Promise<number | null>(resolveStatus => {
    const wall = setTimeout(() => { log += '\ncapture deadline exceeded\n'; child.kill('SIGKILL') }, vshotBudgetMs(180_000))
    child.once('error', error => { log += String(error) })
    child.once('close', code => { clearTimeout(wall); resolveStatus(code) })
  })
  writeFileSync(join(scratch, `${name}.log`), log)
  const payload = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as { marks?: Array<{ label: string; grid: Grid }> }) : null
  const marks = new Map<string, Grid>((payload?.marks ?? []).map(m => [m.label, m.grid]))
  const bytes = existsSync(tee) ? Buffer.concat(readTeeFrames(readFileSync(tee)).map(frame => Buffer.from(frame.data))) : new Uint8Array()
  return { name, marks, bytes, status, log }
}
