#!/usr/bin/env bun
// ============================================================================
//  scripts/cockpit-interaction/prove-scroll-anchor.ts — semantic scroll anchoring under
//  streaming settlement.
//
//  The brief's condition: "if the baseline reproduces visible drift, extend
//  VirtualMessageList's anchor machinery". This IS that baseline, kept as a
//  standing law: scroll up mid-stream, and the reading position must hold
//  byte-still while the turn keeps appending below — the drift class where a
//  streaming settlement yanks the operator's eyes off the row they were
//  reading. The stream is PROVEN to advance through the anchored window (the
//  re-follow mark shows far-later chunks), so a frozen screen can never pass
//  by accident.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { startFixtureApi } from '../lib/fixtureApi.ts'

const t = checker()
const scratch = mkdtempSync(join(tmpdir(), 'hz-anchor-'))

const BIN = 'dist/mercury.mjs'
if (!existsSync(BIN)) {
  t.check('dist exists (build first)', false, BIN)
} else {
  // A long paced stream: plenty of rows above AND below the scrolled window.
  // Long enough to OVERFLOW the 40-row viewport well before the marks — the
  // anchor question only exists once the live tail is off-window.
  const deltas = Array.from({ length: 200 }, (_, i) => `chunk-${i} filling the reading window steadily `)
  const fixture = await startFixtureApi([
    { kind: 'paced', deltas, gapMs: 250, whenModel: 'opus' },
    ...Array.from({ length: 4 }, () => ({ kind: 'text' as const, text: 'ok' })),
  ])

  const home = join(scratch, 'live-home')
  const API_KEY = 'sk-ant-fixture-scroll-anchor-000000000000'
  {
    const seed = spawn(process.execPath, ['run', 'scripts/lib/firstRunSeed.ts', home, process.cwd()], {
      env: { ...process.env, ANTHROPIC_API_KEY: API_KEY },
    })
    await new Promise<void>(resolve => seed.on('exit', () => resolve()))
  }

  const out = join(scratch, 'anchor.json')
  const cfg = {
    cols: 120,
    rows: 40,
    total: 420,
    argv: ['node', BIN],
    out,
    cwd: process.cwd(),
    sends: [
      // THE LANDING RULE: a bare boot lands on the Boot face — ↵ on New Session enters the chat first.
      { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { atTick: 90, awaitText: '? for shortcuts', minTick: 5, awaitSettleTicks: 3, data: 'go\r' },
      // Streaming under way — scroll UP two pages (discrete PageUps), parking
      // the reading position well above the live tail.
      { atTick: 999, awaitText: 'chunk-150 ', minTick: 2, awaitSettleTicks: 1, data: '\u001b[5~' },
      { afterPrevTicks: 2, data: '\u001b[5~' },
      // Two marks ~4s apart with NOTHING driven between them; the stream
      // keeps appending below the window the whole time.
      { afterPrevTicks: 4, data: '', mark: 'anchorA' },
      { afterPrevTicks: 20, data: '', mark: 'anchorB' },
      // Re-follow (ctrl+end) — the tail must now show chunks far past
      // anything the anchored window contained, proving the stream advanced
      // THROUGH the stillness.
      { afterPrevTicks: 2, data: '\u001b[1;5F' },
      { atTick: 999, awaitText: 'chunk-190 ', minTick: 2, awaitSettleTicks: 1, data: '', mark: 'tail' },
    ],
    readyText: '? for shortcuts',
    readySettleTicks: 4,
  }
  const cfgPath = join(scratch, 'anchor-cfg.json')
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const child = spawn('/usr/bin/python3', ['scripts/ui/vshot.py', cfgPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      MERCURY_CONFIG_DIR: home,
      ANTHROPIC_BASE_URL: fixture.url,
      ANTHROPIC_API_KEY: API_KEY,
      MERCURY_BOOT_PREFLIGHT: '0',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_DOCTOR_STATE_DIR: join(scratch, 'doctor'),
      MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let driverOut = ''
  child.stdout.on('data', (d: Buffer) => (driverOut += String(d)))
  child.stderr.on('data', (d: Buffer) => (driverOut += String(d)))
  // The wall rides the hosted profile (an authored wall killed the
  // stretched capture with status null).
  const killer = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(200_000))
  const status = await new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  clearTimeout(killer)
  await fixture.close()

  type Cell = { c: string }
  let payload: { grid?: Cell[][]; marks?: Array<{ label: string; grid: Cell[][] }> } = {}
  try {
    payload = JSON.parse(readFileSync(out, 'utf8'))
  } catch {
    /* reported below */
  }
  const asLines = (g?: Cell[][]): string[] => (g ?? []).map(row => row.map(c => c.c).join(''))
  const markOf = (label: string): string[] =>
    asLines(payload.marks?.find(m => m.label === label)?.grid)

  t.check('the journey completed (vshot exit 0)', status === 0, `exit=${status} ${driverOut.slice(-200)}`)
  const a = markOf('anchorA')
  const b = markOf('anchorB')
  const chunkRows = a
    .map((line, i) => ({ line, i }))
    .filter(r => r.line.includes('chunk-'))
  t.check('the scrolled window really shows transcript rows', chunkRows.length >= 3, `${chunkRows.length} rows`)
  const drifted = chunkRows.filter(r => (b[r.i] ?? '') !== r.line)
  t.check(
    'ZERO DRIFT: every visible transcript row is byte-identical across the marks',
    drifted.length === 0,
    drifted.length > 0 ? `row ${drifted[0]!.i}: "${drifted[0]!.line.trim()}" → "${(b[drifted[0]!.i] ?? '').trim()}"` : `${chunkRows.length} rows held`,
  )
  const tail = markOf('tail')
  t.check(
    'the stream ADVANCED through the stillness (re-follow shows far-later chunks)',
    tail.some(l => l.includes('chunk-190 ')) && !a.some(l => l.includes('chunk-190 ')),
  )
}

rmSync(scratch, { recursive: true, force: true })
t.finish('prove-scroll-anchor')
