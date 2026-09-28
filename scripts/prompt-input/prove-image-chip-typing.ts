#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import stringWidth from 'string-width'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const home = mkdtempSync(join(tmpdir(), 'image-chip-typing-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
const { scenario, cleanupScenario } = await import('../ui/renderScenarios.ts')
const clipboard = join(home, 'clipboard.png')
await sharp({ create: { width: 48, height: 24, channels: 3, background: '#446688' } }).png().toFile(clipboard)
const frameIndex = process.argv.indexOf('--frames')
const frameDir = frameIndex < 0 ? undefined : process.argv[frameIndex + 1]
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label} — ${detail}`)
}
type Mark = { label: string; grid: { c: string }[][]; cursor?: { x: number; y: number; hidden: boolean } }
type Capture = { grid: { c: string }[][]; marks?: Mark[] }
const rowsOf = (grid: { c: string }[][]): string[] => grid.map(row => row.map(cell => cell.c || ' ').join('').trimEnd())
const bands = [{ cols: 178, rows: 51 }, { cols: 80, rows: 21 }, { cols: 120, rows: 40 }]
try {
  for (const band of bands) {
    const cfg = scenario('resume-2turn', band.cols, band.rows)
    const sends = [
      { awaitText: 'Type a prompt', requireAwait: true, awaitSettleTicks: 2, minTick: 15, data: '\x16' },
      { awaitText: '│❯ [Image #1]', requireAwait: true, awaitSettleTicks: 2, data: 'i' },
      { afterPrevTicks: 3, data: '', mark: 'i' },
      { afterPrevTicks: 1, data: 't' },
      { afterPrevTicks: 3, data: '', mark: 'it' },
      { afterPrevTicks: 1, data: 's' },
      { afterPrevTicks: 3, data: '', mark: 'its' },
      { afterPrevTicks: 1, data: '\x05' },
      { afterPrevTicks: 2, data: '\x15' },
      { afterPrevTicks: 3, data: '\x16' },
      { awaitText: '│❯ [Image #2]', requireAwait: true, awaitSettleTicks: 2, data: 'it' },
      { afterPrevTicks: 3, data: '', mark: 'burst' },
    ]
    const out = join(home, `${band.cols}x${band.rows}.json`)
    const config = join(home, `${band.cols}x${band.rows}-cfg.json`)
    writeFileSync(config, JSON.stringify({ argv: cfg.argv, cwd: cfg.cwd, sends, total: 290, ...band, out }))
    const result = spawnSync('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), config], {
      encoding: 'utf8', timeout: vshotBudgetMs(240_000),
      env: { ...process.env, MERCURY_CLIPBOARD_IMAGE_FILE: clipboard, MERCURY_AWAY_SUMMARY: '0' },
    })
    let payload: Capture | undefined
    try { payload = JSON.parse(readFileSync(out, 'utf8')) as Capture } catch {}
    check(`${band.cols}x${band.rows} the real clipboard-paste drive completes`, result.status === 0 && payload !== undefined, `rc ${result.status} ${(result.stderr ?? '').slice(-300)}`)
    for (const word of ['i', 'it', 'its']) {
      const mark = payload?.marks?.find(value => value.label === word)
      const rows = rowsOf(mark?.grid ?? [])
      const y = rows.findLastIndex(row => row.includes('│❯'))
      const row = rows[y] ?? ''
      const expected = `[Image #1] ${word}`
      check(`${band.cols} columns, ${word}: letters remain in typed order`, row.includes(expected), row)
      const end = row.indexOf(expected) + expected.length
      const x = stringWidth(row.slice(0, end))
      check(`${band.cols} columns, ${word}: the cursor is after the last letter`, row.includes(expected) && mark?.cursor?.x === x && mark.cursor.y === y, `expected ${x},${y}; observed ${JSON.stringify(mark?.cursor)}`)
      if (frameDir !== undefined) writeFileSync(join(frameDir, `${band.cols}x${band.rows}-${word}.txt`), rows.join('\n') + `\ncursor ${JSON.stringify(mark?.cursor)}\n`)
    }
    const burst = payload?.marks?.find(value => value.label === 'burst')
    const burstRows = rowsOf(burst?.grid ?? [])
    const burstRow = burstRows.findLast(row => row.includes('│❯')) ?? ''
    check(`${band.cols} columns: a same-event word also stays in order`, /\[Image #2\] ?it\s*│$/.test(burstRow), burstRow)
    if (frameDir !== undefined) writeFileSync(join(frameDir, `${band.cols}x${band.rows}-burst.txt`), burstRows.join('\n') + `\ncursor ${JSON.stringify(burst?.cursor)}\n`)
    cleanupScenario('resume-2turn')
  }
} finally {
  cleanupScenario('resume-2turn')
}
if (failures === 0) rmSync(home, { recursive: true, force: true })
else console.log(`capture evidence: ${home}`)
console.log(`prove-image-chip-typing: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
