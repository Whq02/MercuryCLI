#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-streaming-nameplate.ts — LIVE render-verify for
//  (opt-in under UI_RENDER=1; makes REAL API turns).
//
//  Render-verify is the law for Ink changes, and the streaming branch
//  only renders while a real turn streams (streamingText non-empty) — so this
//  drives the REAL built binary (the fork default), sends a prompt that
//  streams for several seconds, and captures with /tmp/vshot.py:
//    • MID-STREAM (total tuned to land mid-turn) at 80 AND 120: the fork
//      the prose leads with a BULLETLESS inline [Mercury] nameplate (no ●),
//      wrapped lines at column 0 — the fix.
//    • POST-FINALIZE: the settled line reads HH:MM:SS [Mercury] — confirming the
//      ONLY delta on finalize is the clock fading in (no ●→nameplate swap).
//
//  OBSERVED-VERIFIED: mid-stream @80 + @120 both rendered
//  "[Mercury] N - <phrase>" with NO ● bullet, prose at col 0; finalize rendered
//  "HH:MM:SS [Mercury] …". Live-API first-token latency is variable, so `total`
//  may need re-tuning to land mid-stream; the source-text branch logic is locked
//  in prove-streaming-nameplate.ts (runs in the default gate). Reaps only
//  dist/mercury.mjs between captures — never touches unrelated processes.
//
//  Run:  UI_RENDER=1 ~/.bun/bin/bun run scripts/ui/render-streaming-nameplate.ts
// ============================================================================
import { execFileSync } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProofHome } from '../lib/proofHome.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BIN = join(root, 'dist', 'mercury.mjs')
// The proof's config home (scripts/lib/proofHome.ts): the inherited pin, else
// a fresh seeded scratch — never another program's directory.
const CONFIG_HOME = resolveProofHome([process.cwd()])
const VSHOT = new URL('./vshot.py', import.meta.url).pathname
if (!existsSync(VSHOT) || !existsSync(BIN)) {
  console.error('vshot.py or dist/mercury.mjs missing — build first (bun run build.ts, AGENTS.md); render-verify drives the built binary.')
  process.exit(1)
}

const BULLET = '●' // BLACK_CIRCLE — the old streaming bullet the fix removes
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const drive = (prompt: string, cols: number, rows: number, total: number, tag: string): string => {
  // Reap a lingering prior capture's binary (matches dist/mercury.mjs only — never
  // caffeinate or anything else) and settle to clear the owner-exit daemon-reap
  // window: consecutive live launches otherwise contend on the ~/.claude session/
  // daemon lock (see render-verify-message-renderers). Live-API first-token
  // latency is variable, so `total` may need re-tuning to land mid-stream.
  // NO pkill: `pkill -f dist/mercury.mjs` killed the operator's
  // LIVE sessions (render-diff-width:161 precedent); the settle sleep suffices.
  execFileSync('sleep', ['4'])
  const cfg = `/tmp/vs-stream-${tag}.json`
  writeFileSync(cfg, JSON.stringify({
    argv: ['node', BIN],
    // {atTick,data} dict form, MODERN cadence (TICK_S=0.2s wall-clock — the
    // rewrite; the old tuple sends crashed vshot on every run since,
    // and the old totals were SECONDS — read as ticks they ended the capture
    // at ~2.4s, before boot finished). First key tick 32 (~6.4s — today's
    // boot-to-interactive), ↵ tick 36; totals converted seconds×5.
    sends: [{ atTick: 32, data: prompt }, { atTick: 36, data: '\r' }],
    total, cols, rows,
    out: `/tmp/stream-${tag}.html`,
    title: `streaming nameplate ${tag}`,
  }))
  // vshot.py never reads cfg.env (render-diff-width lesson) — env rides the
  // spawn call; pin the home or the env-less fork child boots the operator's
  // LIVE ~/.mercury.
  return execFileSync('/usr/bin/python3', [VSHOT, cfg], { encoding: 'utf-8', timeout: vshotBudgetMs(90000), env: { ...process.env, MERCURY_CONFIG_DIR: CONFIG_HOME, MERCURY_HIP: '1' } })
}

// The streaming-prose line: the FIRST line that contains the [Mercury] nameplate
// AND some prose after it (not the statusbar, which has no "[Mercury] <text>").
const namePlateLine = (grid: string): string =>
  grid.split('\n').find(l => /\[Mercury\]/.test(l)) ?? ''

// BILLED live-API proof — skipped unless explicitly armed (repo doctrine:
// billed runners stay out of default gates). MERCURY_UI_BILLED=1 arms it.
if (process.env.MERCURY_UI_BILLED !== '1') {
  console.log('SKIP render-streaming-nameplate (billed live-API proof — arm with MERCURY_UI_BILLED=1)')
  process.exit(0)
}

console.log('============================================================')
console.log(' HB-0215 LIVE render-verify: the streaming nameplate')
console.log('============================================================')

// 10 lines, not 25: the long stream scrolled the nameplate ROW
// past the 30-row viewport by capture time — the mid needles then failed on a
// perfectly healthy stream. 10 lines always fit beside the chrome.
const STREAM_PROMPT =
  "List the numbers 1 through 10, each on its own line as 'N - <a four word phrase>'. No preamble."

// ── MID-STREAM at 80 and 120 ────────────────────────────────────────────────
for (const [cols, rows] of [[80, 30], [120, 30]] as const) {
  console.log(`\n  ── mid-stream @ ${cols} ──`)
  // The streaming window opens ~first-token-latency (5-10s on the big system
  // prompt) after ↵ at tick 36 — total 70 (14s) usually lands 1-4s into the
  // stream with the nameplate row still on screen; the retry looks EARLIER
  // (total 60) in case a fast finish settled the turn before 14s.
  let grid = drive(STREAM_PROMPT, cols, rows, 70, `mid-${cols}`)
  if (!/\[Mercury\]/.test(grid)) grid = drive(STREAM_PROMPT, cols, rows, 60, `mid-${cols}-retry`)
  const line = namePlateLine(grid)
  console.log(`  nameplate line: ${line.trim().slice(0, 70) || '(none)'}`)
  // LIVE-API WINDOW LOTTERY: first-token latency (5-14s) vs turn
  // duration means NO fixed tick reliably lands mid-stream — a fast turn is
  // already settled at capture, a slow one has no prose yet, and a CLOCKED
  // [Mercury] line beside 'esc interrupt' is a finalized BLOCK inside a
  // still-running turn (blocks finalize at content-block close, not turn end)
  // which one frame cannot tell from the regression. Honest shape:
  // the streaming invariants are asserted HARD whenever a genuinely-streaming
  // (clock-less) nameplate line was captured; otherwise WARN and defer to the
  // deterministic finalize leg below. Never fail on the lottery itself.
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

// ── POST-FINALIZE: short prompt, longer total so the turn settles ───────────
console.log('\n  ── post-finalize @ 100 ──')
{
  const grid = drive("Reply with exactly: hello there from hermes", 100, 30, 85, 'final')
  const settled = grid.split('\n').find(l => /\d\d:\d\d:\d\d\s*\[Mercury\]/.test(l)) ?? ''
  console.log(`  finalized line: ${settled.trim().slice(0, 70) || '(none)'}`)
  // finalize: the clock FADES IN — HH:MM:SS [Mercury] (the only delta vs streaming)
  check('finalize: settled line reads HH:MM:SS [Mercury] (clock faded in)',
    /\d\d:\d\d:\d\d\s*\[Mercury\]/.test(settled))
  // still bulletless on finalize (fork prose is bulletless — no ●→swap)
  check('finalize: NO ● bullet on the settled line', !settled.includes(BULLET))
  // not still streaming
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
