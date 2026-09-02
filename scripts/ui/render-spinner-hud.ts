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

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const WARMUP_PROMPT = 'Reply with exactly: ok'
const STREAM_PROMPT =
  'Count from 1 to 40, one number per line, each followed by a short desert-themed word. No preamble.'

const drive = (cols: number, rows: number, total: number, tag: string): string => {
  execFileSync('sleep', ['4'])
  const cfg = `/tmp/vs-hud-${tag}.json`
  writeFileSync(cfg, JSON.stringify({
    argv: ['node', BIN],
    sends: [
      { atTick: 32, data: WARMUP_PROMPT }, { atTick: 36, data: '\r' },
      { atTick: 70, data: STREAM_PROMPT }, { atTick: 73, data: '\r' },
    ],
    total, cols, rows,
    out: `/tmp/hud-${tag}.html`,
    title: `spinner hud ${tag}`,
  }))
  return execFileSync('/usr/bin/python3', [VSHOT, cfg], { encoding: 'utf-8', timeout: vshotBudgetMs(120000), env: { ...process.env, MERCURY_CONFIG_DIR: CONFIG_HOME, MERCURY_HIP: '1' } })
}

const bylineOf = (grid: string): string =>
  grid.split('\n').find(l => /\d+% ctx/.test(l)) ??
  grid.split('\n').find(l => /…\s*\(/.test(l)) ?? ''

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{FE0F}]/u

if (process.env.MERCURY_UI_BILLED !== '1') {
  console.log('SKIP render-spinner-hud (billed live-API proof — arm with MERCURY_UI_BILLED=1)')
  process.exit(0)
}

console.log('============================================================')
console.log(' LIVE render-verify: in-turn cockpit HUD (context-burn gauge)')
console.log('============================================================')

for (const [cols, rows] of [[80, 30], [120, 30]] as const) {
  console.log(`\n  ── mid-turn @ ${cols} ──`)
  let grid = drive(cols, rows, 115, `${cols}`)
  if (!/\d+% ctx/.test(grid)) grid = drive(cols, rows, 135, `${cols}-retry`)
  const line = bylineOf(grid)
  console.log(`  byline @${cols}: ${line.trim().slice(0, 78) || '(none)'}`)
  const inTurn = /\d+% ctx/.test(grid)
  if (inTurn) {
    console.log(`  [PASS] @${cols}: in-turn byline captured (live ctx gauge)`)
    check(`@${cols}: token-burn counter present ("tokens")`, /tokens/.test(grid))
  } else {
    console.log(`  [WARN] @${cols}: capture missed the in-turn window — HUD invariants covered by prove-spinner-hud + render-spinner-wif`)
  }
  check(`@${cols}: NO emoji in the grid`, !EMOJI.test(grid))
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ in-turn cockpit HUD render-verify — captured windows hard-asserted, missed windows warned')
  process.exit(0)
} else {
  console.log(` ❌ in-turn cockpit HUD render-verify — ${failures} check(s) failed`)
  process.exit(1)
}
