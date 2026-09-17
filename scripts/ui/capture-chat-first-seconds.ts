#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ADMITTED, childEnv, DIST, endLeg, FACE_READY, productNode, requireCaptureDriver, ROOT, scratch, startLeg } from '../computer/computerDriveKit.ts'
import { captureEngineEntry, vshotBudgetMs } from '../lib/captureDriver.ts'

type Cell = { c: string }
type Grid = Cell[][]
type Mark = { label: string; atTick: number; cols: number; rows: number; grid: Grid }

const argOf = (name: string): string | undefined => process.argv.slice(2).find(a => a.startsWith(`${name}=`))?.slice(name.length + 1)
const dist = argOf('--dist') ?? DIST
const frames = argOf('--frames') ?? join(scratch, 'first-seconds')
const sizes = (argOf('--sizes') ?? '80x21,80x14,82x17,120x40').split(',').map(s => s.split('x').map(Number) as [number, number])
const driver = requireCaptureDriver('chat-first-seconds')
const textRows = (grid: Grid): string[] => grid.map(row => row.map(c => c.c).join('').replace(/\s+$/, ''))
mkdirSync(frames, { recursive: true })
console.log(`chat first-seconds frames → ${frames} (dist: ${dist})`)

for (const [cols, rows] of sizes) {
  const tag = `first-seconds-${cols}x${rows}`
  const settledText = cols >= 100 && rows >= 26 ? '· ready' : cols >= 60 ? '1 session on · 0 monitors here · 0 agents here' : 'S:1 · M:0 · A:0'
  const leg = await startLeg(tag, [{ kind: 'text', text: 'Finished.' }], null)
  const out = join(scratch, `${tag}.json`)
  const cfgPath = join(scratch, `${tag}-config.json`)
  writeFileSync(cfgPath, JSON.stringify({
    argv: [productNode(), dist, '--chat'],
    cwd: ROOT,
    cols,
    rows,
    sends: [
      { atTick: 40, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r', mark: 'boot' },
      { atTick: 100, awaitText: ADMITTED, minTick: 5, awaitSettleTicks: 0, requireAwait: true, data: '', mark: 'first' },
      { afterPrevTicks: 3, data: '', mark: 'first-later' },
      { atTick: 999, awaitText: settledText, minTick: 5, awaitSettleTicks: 4, awaitStableTicks: 3, requireAwait: true, data: '', mark: 'settled' },
    ],
    resizes: [],
    total: 200,
    out,
  }))
  const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], { cwd: ROOT, env: childEnv(leg, { MERCURY_DESKTOP_DRIVER: 'none', MERCURY_DECK_COMPANION: '0' }), stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  const status = await new Promise<number | null>(resolve => {
    const wall = setTimeout(() => { output += '\ncapture deadline exceeded\n'; child.kill('SIGKILL') }, vshotBudgetMs(200 * 200 + 60_000))
    child.once('error', error => { output += `\n${String(error)}\n` })
    child.once('close', code => { clearTimeout(wall); resolve(code) })
  })
  await endLeg(leg)
  writeFileSync(join(frames, `${tag}-engine.log`), output)
  const marks = new Map<string, Mark>()
  if (existsSync(out)) for (const mark of (JSON.parse(readFileSync(out, 'utf8')) as { marks?: Mark[] }).marks ?? []) marks.set(mark.label, mark)
  for (const label of ['first', 'first-later', 'settled']) {
    const mark = marks.get(label)
    const rowsText = mark === undefined ? '(no frame)' : textRows(mark.grid).join('\n')
    writeFileSync(join(frames, `${label}-${cols}x${rows}.txt`), `${rowsText}\n`)
    const chipRow = mark === undefined ? '' : textRows(mark.grid).find(l => /permissions unreported|sovereign|need you/.test(l)) ?? ''
    console.log(`  ${tag} ${label}: tick ${mark?.atTick ?? '?'} · exit ${status} · mode words: ${JSON.stringify(chipRow)} · sessions line: ${JSON.stringify(mark === undefined ? '' : textRows(mark.grid).find(l => /sessions? on|S:\d/.test(l)) ?? '')}`)
  }
}
