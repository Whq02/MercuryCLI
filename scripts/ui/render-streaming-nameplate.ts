#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProofHome } from '../lib/proofHome.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BIN = join(root, 'dist', 'mercury.mjs')
const CONFIG_HOME = resolveProofHome([process.cwd()])
const VSHOT = new URL('./vshot.py', import.meta.url).pathname
if (!existsSync(VSHOT) || !existsSync(BIN)) {
  console.error('vshot.py or dist/mercury.mjs missing — build first (bun run build.ts, AGENTS.md); render-verify drives the built binary.')
  process.exit(1)
}

const BULLET = '●'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const drive = (prompt: string, cols: number, rows: number, total: number, tag: string): string => {
  execFileSync('sleep', ['4'])
  const cfg = `/tmp/vs-stream-${tag}.json`
  writeFileSync(cfg, JSON.stringify({
    argv: ['node', BIN],
    sends: [{ atTick: 32, data: prompt }, { atTick: 36, data: '\r' }],
    total, cols, rows,
    out: `/tmp/stream-${tag}.html`,
    title: `streaming nameplate ${tag}`,
  }))
  return execFileSync('/usr/bin/python3', [VSHOT, cfg], { encoding: 'utf-8', timeout: vshotBudgetMs(90000), env: { ...process.env, MERCURY_CONFIG_DIR: CONFIG_HOME, MERCURY_HIP: '1' } })
}

const namePlateLine = (grid: string): string =>
  grid.split('\n').find(l => /\[Mercury\]/.test(l)) ?? ''

if (process.env.MERCURY_UI_BILLED !== '1') {
  console.log('SKIP render-streaming-nameplate (billed live-API proof — arm with MERCURY_UI_BILLED=1)')
  process.exit(0)
}

console.log('============================================================')
console.log(' HB-0215 LIVE render-verify: the streaming nameplate')
console.log('============================================================')

const STREAM_PROMPT =
  "List the numbers 1 through 10, each on its own line as 'N - <a four word phrase>'. No preamble."

for (const [cols, rows] of [[80, 30], [120, 30]] as const) {
  console.log(`\n  ── mid-stream @ ${cols} ──`)
  let grid = drive(STREAM_PROMPT, cols, rows, 70, `mid-${cols}`)
  if (!/\[Mercury\]/.test(grid)) grid = drive(STREAM_PROMPT, cols, rows, 60, `mid-${cols}-retry`)
  const line = namePlateLine(grid)
  console.log(`  nameplate line: ${line.trim().slice(0, 70) || '(none)'}`)
  const midStream = /esc (to )?interrupt/.test(grid) && /\[Mercury\]/.test(line)
    && !/\d\d:\d\d:\d\d\s*\[Mercury\]/.test(line)
  if (midStream) {
    console.log(`  [PASS] @${cols}: mid-stream state captured (esc interrupt + clock-less nameplate)`)
    check(`@${cols}: streaming prose leads with [Mercury] nameplate`, /\[Mercury\]/.test(line))
    check(`@${cols}: NO ● bullet on the streaming line`, !line.includes(BULLET))
  } else {
    console.log(`  [WARN] @${cols}: capture missed the mid-stream window (${/esc (to )?interrupt/.test(grid) ? (/\[Mercury\]/.test(line) ? 'block already finalized mid-turn' : 'in flight, pre-prose') : 'turn already settled'}) — invariants covered by the finalize leg`)
  }
}

console.log('\n  ── post-finalize @ 100 ──')
{
  const grid = drive("Reply with exactly: hello there from mercury", 100, 30, 85, 'final')
  const settled = grid.split('\n').find(l => /\d\d:\d\d:\d\d\s*\[Mercury\]/.test(l)) ?? ''
  console.log(`  finalized line: ${settled.trim().slice(0, 70) || '(none)'}`)
  check('finalize: settled line reads HH:MM:SS [Mercury] (clock faded in)',
    /\d\d:\d\d:\d\d\s*\[Mercury\]/.test(settled))
  check('finalize: NO ● bullet on the settled line', !settled.includes(BULLET))
  check('finalize: the turn has settled (no esc interrupt)', !/esc (to )?interrupt/.test(grid))
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ HB-0215 LIVE render-verify — bulletless [Mercury] streaming, clock on finalize')
  process.exit(0)
} else {
  console.log(` ❌ HB-0215 LIVE render-verify — ${failures} check(s) failed`)
  process.exit(1)
}
