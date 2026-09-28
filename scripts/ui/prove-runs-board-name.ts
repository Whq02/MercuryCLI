#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const home = mkdtempSync(join(tmpdir(), 'runs-board-name-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
const { scenario, cleanupScenario } = await import('./renderScenarios.ts')
const frameIndex = process.argv.indexOf('--frames')
const frameDir = frameIndex < 0 ? undefined : process.argv[frameIndex + 1]
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label} — ${detail}`)
}
type Mark = { label: string; grid: { c: string }[][] }
type Capture = { grid: { c: string }[][]; marks?: Mark[] }
const rowsOf = (grid: { c: string }[][]): string[] => grid.map(row => row.map(cell => cell.c || ' ').join('').trimEnd())
try {
  for (const band of [{ cols: 178, rows: 51 }, { cols: 80, rows: 21 }, { cols: 120, rows: 40 }]) {
    for (const command of ['runs', 'tasks']) {
      const cfg = scenario('resume-2turn', band.cols, band.rows)
      const sends = [
        { awaitText: 'Type a prompt', requireAwait: true, awaitSettleTicks: 3, data: `/${command}` },
        { afterPrevTicks: 3, data: '\r' },
        { awaitPattern: 'Mercury — (runs|tasks)|Unknown (command|skill): /?runs', afterPrevTicks: 8, data: '', mark: 'board' },
      ]
      const out = join(home, `${band.cols}-${command}.json`)
      const config = `${out}.cfg.json`
      writeFileSync(config, JSON.stringify({ ...cfg, sends, total: 160, ...band, out }))
      const result = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), config], {
        encoding: 'utf8', timeout: vshotBudgetMs(180_000), env: { ...process.env, MERCURY_AWAY_SUMMARY: '0' },
      })
      let payload: Capture | undefined
      try { payload = JSON.parse(readFileSync(out, 'utf8')) as Capture } catch {}
      const frame = rowsOf(payload?.marks?.find(mark => mark.label === 'board')?.grid ?? payload?.grid ?? [])
      if (frameDir !== undefined) writeFileSync(join(frameDir, `${band.cols}x${band.rows}-${command}.txt`), frame.join('\n') + '\n')
      check(`${band.cols}: /${command} completes its command road`, result.status === 0 && payload?.marks?.some(mark => mark.label === 'board') === true, `rc ${result.status} ${(result.stderr ?? '').slice(-300)}`)
      const heading = frame.find(row => row.includes('Mercury — runs') || row.includes('Mercury — tasks') || row.includes('Unknown command') || row.includes('Unknown skill')) ?? ''
      check(`${band.cols}: /${command} opens the runs board`, heading.includes('Mercury — runs') && !heading.includes('Unknown'), heading)
      cleanupScenario('resume-2turn')
    }
  }
} finally {
  cleanupScenario('resume-2turn')
}
if (failures === 0) rmSync(home, { recursive: true, force: true })
else console.log(`capture evidence: ${home}`)
console.log(`prove-runs-board-name: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
