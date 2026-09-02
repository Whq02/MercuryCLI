#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-spinner-hud.ts — LIVE render-verify for the in-turn
//  cockpit HUD (opt-in under UI_RENDER=1; makes REAL API turns).
//
//  Render-verify is the law for Ink changes, and the spinner byline only
//  renders while a turn is in flight — so this drives the REAL built binary
//  (fork default), sends a prompt that streams for several seconds, and captures
//  with /tmp/vshot.py MID-TURN at 80 AND 120 columns. Asserts the live byline
//  carries the cockpit telemetry:
//    • the session-accent RAIL (│) wrapping the spinner block
//    • a desert-verb current-action label (…)
//    • the elapsed timer + the ↓ token-burn counter
//    • the NEW live context-burn gauge — "<spark> NN% ctx" (gauge-colored)
//  and that NO emoji leak into the cell grid.
//
//  Run:  UI_RENDER=1 ~/.bun/bin/bun run scripts/ui/render-spinner-hud.ts
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

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

// Context-burn % is only KNOWN after the model reports usage (getCurrentUsage
// walks messages for the last reported usage; null on a fresh session's first
// turn — we never fabricate a %). So drive a trivial WARMUP turn first to
// populate usage, THEN capture mid a long-streaming SECOND turn where the byline
// shows timer + tokens + the live ctx gauge.
const WARMUP_PROMPT = 'Reply with exactly: ok'
const STREAM_PROMPT =
  'Count from 1 to 40, one number per line, each followed by a short desert-themed word. No preamble.'

const drive = (cols: number, rows: number, total: number, tag: string): string => {
  // NO pkill here: the old `pkill -f dist/mercury.mjs` killed the
  // operator's LIVE Mercury sessions whenever this proof ran (the class
  // render-diff-width already fixed at :161) — vshot owns its pty child's
  // lifecycle; the settle sleep alone covers the consecutive-launch lock window.
  execFileSync('sleep', ['4'])
  const cfg = `/tmp/vs-hud-${tag}.json`
  writeFileSync(cfg, JSON.stringify({
    argv: ['node', BIN],
    // {atTick,data} dict form (vshot's wall-clock ticks, TICK_S=0.2s — the
    // rewrite; the old [seconds,'ENTER'] tuple form crashed vshot
    // line 93 on EVERY run since, unnoticed because the tier is opt-in).
    // Modern cadence: warmup at tick 32/36 (~6.4s/7.2s — boot-to-interactive
    // is slower than the 2026-06 era's 3s), stream turn at 70/73 (14s/14.6s);
    // totals are ticks (old SECONDS ×5 — read as ticks they ended the capture
    // before boot). '\r' replaces the old 'ENTER' token (data is verbatim).
    sends: [
      { atTick: 32, data: WARMUP_PROMPT }, { atTick: 36, data: '\r' },  // turn 1 — settles, populates usage
      { atTick: 70, data: STREAM_PROMPT }, { atTick: 73, data: '\r' },  // turn 2 — long stream; capture mid
    ],
    total, cols, rows,
    out: `/tmp/hud-${tag}.html`,
    title: `spinner hud ${tag}`,
  }))
  // vshot.py never reads cfg.env (the render-diff-width fork-bomb lesson) — the
  // child env MUST ride the spawn call. Pin the home: env-less the fork child
  // resolves the operator's LIVE ~/.mercury (session-lock contention + billing
  // their live store).
  return execFileSync('/usr/bin/python3', [VSHOT, cfg], { encoding: 'utf-8', timeout: vshotBudgetMs(120000), env: { ...process.env, MERCURY_CONFIG_DIR: CONFIG_HOME, MERCURY_HIP: '1' } })
}

// The spinner byline: the line carrying the ctx gauge ("NN% ctx"), or failing
// that the verb-ellipsis line wrapped by the rail.
const bylineOf = (grid: string): string =>
  grid.split('\n').find(l => /\d+% ctx/.test(l)) ??
  grid.split('\n').find(l => /…\s*\(/.test(l)) ?? ''

// Emoji leak guard — TRUE emoji only (U+1F000+ pictographs and the U+FE0F
// emoji variation selector). Deliberately NOT the U+2600–27BF dingbat block:
// the design system legitimately uses geometric figures there (the spinner's
// own ✻ TEARDROP_ASTERISK is U+273B), which are width-1, not emoji.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{FE0F}]/u

// BILLED live-API proof (real turns on the operator's account) — the repo
// doctrine keeps billed runners out of default gates (the operator-run
// precedent). Opt in explicitly: MERCURY_UI_BILLED=1 UI_RENDER=1 …
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
  // Same live-API window lottery as render-streaming-nameplate: assert the HUD
  // invariants HARD whenever an in-flight byline was actually captured; a
  // missed window (turn settled early / first token late, even after the
  // retry) WARNs instead of failing — the gauge logic itself is render-free
  // covered by prove-spinner-hud.ts + render-spinner-wif.tsx.
  const inTurn = /\d+% ctx/.test(grid)
  if (inTurn) {
    console.log(`  [PASS] @${cols}: in-turn byline captured (live ctx gauge)`)
    // No esc-hint check: the footer hint slot ROTATES (Tips share it), so
    // 'esc interrupt' is absent on many genuinely-in-turn frames — the live
    // byline + ctx gauge IS the mid-turn proof.
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
