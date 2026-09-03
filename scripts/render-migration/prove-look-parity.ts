#!/usr/bin/env bun
// ============================================================================
//  scripts/render-migration/prove-look-parity.ts — LOOK PARITY, the
//  migration gate ("settled cockpit frames
//  byte-identical to today's on the capture matrix — the painter changes,
//  the picture does not").
//
//  The REAL built artifact boots in a real PTY (vshot.py → pyte) on the
//  capture matrix — 120x40 and 100x30, dark and light — twice per cell:
//  MERCURY_RENDER_ENGINE unset (today's painter) and =1 (the engine mount,
//  tripwires armed). The scripted stream (slow-text) drives one prompt to a
//  settled reply. Three settled instants compare cell-for-cell — glyphs
//  AND styles — through the visual-baseline library's own masks (the live
//  clock, relative ages, git chips: the environmental diffs the baseline
//  provers already neutralize):
//    · the idle composer before the prompt (mark 'idle'),
//    · the settled reply (mark 'settled'),
//    · the final frame at budget end.
//  Any other difference is a parity break — reported as the FIRST divergent
//  cell with both rows, never a loose threshold.
//
//  Animation instants are held still the way the baseline captures hold
//  them (live glyphs, critter gaze, turn receipts, the Minerva line off);
//  the fixture cwd is an owned non-git directory so the status rows carry
//  no live tree state.
//
//  Run: ~/.bun/bin/bun run scripts/render-migration/prove-look-parity.ts
//       [--skip-build] [--cells 120x40,100x30] [--themes dark,light]
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
const OUT_DIR = process.env.PARITY_OUT_DIR ?? mkdtempSync(join(tmpdir(), 'look-parity-'))

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const CELLS = (arg('--cells') ?? '120x40,100x30').split(',').map(s => {
  const [c, r] = s.split('x').map(Number)
  return { cols: c!, rows: r! }
})
const THEMES = (arg('--themes') ?? 'dark,light').split(',')

console.log('============================================================')
console.log(' look parity — settled cockpit frames, engine ON vs OFF')
console.log(`  captures → ${OUT_DIR}`)
console.log('============================================================')

// ── the stale-dist guard: rebuild before every capture unless told not to ──
if (!process.argv.includes('--skip-build')) {
  const build = spawnSync(process.execPath, ['run', 'build.ts'], { cwd: REPO, encoding: 'utf8', timeout: 600_000 })
  check('dist rebuilt from this tree (stale-dist guard)', build.status === 0, (build.stderr ?? '').slice(-300))
}
if (!existsSync(BIN)) {
  check('dist/mercury.mjs exists', false)
  process.exit(1)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { compactGrid, firstDivergence, DEFAULT_MASKS } = await import('../ui/visualBaseline.ts')
type RawGridT = Parameters<typeof compactGrid>[0]

// ── the owned fixture cwd (non-git, stable) ────────────────────────────────
const FIX = join(OUT_DIR, 'fixture-cwd')
mkdirSync(FIX, { recursive: true })
writeFileSync(join(FIX, 'README.md'), '# look-parity capture fixture\n')
const FIX_REAL = realpathSync(FIX)

type Leg = 'off' | 'on'
type Capture = { marks: Record<string, RawGridT>; final: RawGridT; ok: boolean; detail: string }

function capture(cols: number, rows: number, theme: string, leg: Leg): Capture {
  const tag = `${cols}x${rows}-${theme}-${leg}`
  const home = join(OUT_DIR, `home-${tag}`)
  process.env.ANTHROPIC_API_KEY = 'proof-key-scripted-stream'
  seedFirstRun(home, [FIX, FIX_REAL])
  // Theme: the seed writes dark; the light legs patch the seeded file.
  const cfgFile = join(home, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>
  cfg.theme = theme
  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  // The environmental masks, as the baseline provers hold them: reduced
  // motion stills the critter's idle sway (the visual-baseline generator's
  // own motion posture), and the post-turn tip bubble is a RANDOM pick —
  // pinned off by the product's own setting. Neither touches the painter;
  // both legs are asked to paint the same picture.
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({ prefersReducedMotion: true, spinnerTipsEnabled: false }),
  )
  // The critter's COMPANION speech is a seeded random tip deck per home
  // (utils/cockpit/companionEngine.ts); its own persisted preference,
  // `quiet`, silences every line and keeps the creature drawn — the
  // posture both legs share here, with one fixed seed for good measure.
  writeFileSync(
    join(home, 'critter-profile.json'),
    JSON.stringify({
      v: 1,
      seed: '00000000-0000-4000-8000-00000000c0de',
      createdAt: 1_787_600_000_000,
      milestones: { settles: 0, recoveries: 0 },
      quiet: true,
      seenTips: {},
      openedSurfaces: [],
    }),
  )

  const gridPath = join(OUT_DIR, `grid-${tag}.json`)
  const vshotCfg = join(OUT_DIR, `vshot-${tag}.json`)
  writeFileSync(
    vshotCfg,
    JSON.stringify({
      argv: ['node', BIN],
      cwd: FIX,
      cols,
      rows,
      total: 220,
      sends: [
        // THE LANDING RULE (line 4, signed (b)): ↵ on the face's New Session
        // first. STRICT SENDS (requireAwait, atTick 999): the birth on a
        // fresh home is a real daemon spawn + admit (~20 s), and a blind
        // atTick schedule typed the prompt INTO the face→chat transition —
        // the old idle mark's '❯' await matched the FACE's own row marker,
        // so every capture "settled" on an empty chat.
        { atTick: 999, requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
        // The idle composer, settled: gated on the composer's OWN placeholder,
        // and on the WHOLE GRID standing byte-identical for three ticks — a
        // fixed grace after the placeholder is not a settled frame on a slow
        // runner (a rule row snapshotted half-painted graded the two legs
        // different on one glyph); byte-identity is asked of settled frames.
        { atTick: 999, requireAwait: true, awaitText: 'Type a prompt', minTick: 5, awaitSettleTicks: 4, awaitStableTicks: 3, data: '', mark: 'idle' },
        // The prompt; the scripted stream holds an 8s active window. The
        // submit rides its OWN send: a CR inside a one-write burst is the
        // typed law's paste NEWLINE, never a submit (the seal/burst
        // composition).
        { afterPrevTicks: 1, data: 'parity drive prompt' },
        { afterPrevTicks: 2, data: '\r' },
        // The settled reply, four quiet ticks after its text lands and the
        // grid byte-identical for three (the same settled-frame law).
        { atTick: 999, requireAwait: true, awaitText: 'Scripted stream settled', minTick: 20, awaitSettleTicks: 4, awaitStableTicks: 3, data: '', mark: 'settled' },
      ],
      out: gridPath,
    }),
  )
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // The credential door sits upstream of the scripted-stream seam: a
    // keyless world refuses the dispatch before the script plays. The
    // scene pins its own proof key (no real call is possible).
    ANTHROPIC_API_KEY: 'proof-key-scripted-stream',
    MERCURY_SCRIPTED_STREAM: 'slow-text',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_TABULA_MINERVA: '0',
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(OUT_DIR, `daemon-${tag}`),
    MERCURY_TEAMS_DIR: join(OUT_DIR, `teams-${tag}`),
    MERCURY_TABULA_DIR: join(OUT_DIR, `tabula-${tag}`),
    MERCURY_HOME: join(OUT_DIR, `mhome-${tag}`),
    VISUAL: '',
    EDITOR: '',
  }
  delete env.MERCURY_RENDER_ENGINE
  delete env.MERCURY_ENGINE_ASSERT
  if (leg === 'on') {
    env.MERCURY_RENDER_ENGINE = '1'
    env.MERCURY_ENGINE_ASSERT = '1'
  }
  const res = spawnSync('/usr/bin/python3', [VSHOT, vshotCfg], { encoding: 'utf8', timeout: vshotBudgetMs(240_000), env })
  if (res.status !== 0) {
    return { marks: {}, final: { cols, rows, grid: [] }, ok: false, detail: (res.stderr ?? '').slice(-400) }
  }
  const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as {
    grid: RawGridT['grid']
    marks?: Array<{ label: string; grid: RawGridT['grid'] }>
    endReason?: string
  }
  const marks: Record<string, RawGridT> = {}
  for (const m of payload.marks ?? []) marks[m.label] = { cols, rows, grid: m.grid }
  return { marks, final: { cols, rows, grid: payload.grid }, ok: true, detail: payload.endReason ?? '' }
}

const gridText = (g: RawGridT): string => g.grid.map(r => r.map(c => c.c).join('')).join('\n')

for (const { cols, rows } of CELLS) {
  for (const theme of THEMES) {
    section(`${cols}x${rows} · ${theme}`)
    const off = capture(cols, rows, theme, 'off')
    check(`OFF capture ran (${cols}x${rows} ${theme})`, off.ok, off.detail)
    const on = capture(cols, rows, theme, 'on')
    check(`ON capture ran (${cols}x${rows} ${theme})`, on.ok, on.detail)
    if (!off.ok || !on.ok) continue

    // The drive reached its instants on BOTH legs (a mark missing on one
    // side is a drive fault, not a parity verdict).
    for (const mark of ['idle', 'settled']) {
      check(`both legs reached the '${mark}' instant`, mark in off.marks && mark in on.marks, `off=${Object.keys(off.marks)} on=${Object.keys(on.marks)}`)
    }
    // The settled reply is genuinely on screen on both legs.
    check('the settled reply text is on screen (OFF)', gridText(off.final).includes('Scripted stream settled'))
    check('the settled reply text is on screen (ON)', gridText(on.final).includes('Scripted stream settled'))

    const instants: Array<[string, RawGridT | undefined, RawGridT | undefined]> = [
      ['idle', off.marks.idle, on.marks.idle],
      ['settled', off.marks.settled, on.marks.settled],
      ['final', off.final, on.final],
    ]
    for (const [name, a, b] of instants) {
      if (!a || !b) continue
      const d = firstDivergence(compactGrid(a), compactGrid(b), DEFAULT_MASKS)
      check(
        `${name}: settled frame byte-identical ON vs OFF (glyphs + styles, baseline masks)`,
        d === null,
        d ? `first divergence row ${d.row} col ${d.col} (${d.kind}): ${d.old} vs ${d.new}\n      OFF: ${JSON.stringify(d.oldRow)}\n      ON : ${JSON.stringify(d.newRow)}` : '',
      )
    }
  }
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
console.log(`captures kept at ${OUT_DIR}`)
process.exit(failures === 0 ? 0 : 1)
