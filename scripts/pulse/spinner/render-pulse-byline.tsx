#!/usr/bin/env bun
// ============================================================================
//  scripts/pulse/spinner/render-pulse-byline.tsx — RENDER-verify for the
//  phase byline + the restrained still-waiting treatment (repo law: a
//  broken layout only shows in the render).
//
//  Mounts SpinnerAnimationRow DIRECTLY (the render-spinner-wif pattern) with
//  the REAL pulse store driven to deterministic states under a pinned clock,
//  captured through vshot (PTY → pyte cell grid) at 120 + 80 + 40 cols and
//  written to PNGs for the human look:
//    · waiting  — "Scuttling · waiting for Fable 5 · high · 3.4s" on the
//      info channel (the voice law: the verb heads, the phase truth rides);
//      at 40 cols the byline sheds elapsed + effort (one line, right-to-left);
//    · stillwaiting — responding with a 12s mid-stream gap: the quiet
//      "still waiting" suffix + the amber-eased verb (never failure red).
//
//  Run: UI_RENDER=1 ~/.bun/bin/bun run scripts/pulse/spinner/render-pulse-byline.tsx
// ============================================================================
process.env.NODE_ENV = 'test' // ThemeProvider/getTheme read getGlobalConfig at mount

import { execFileSync } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProofHome } from '../../lib/proofHome.ts'

const SELF = fileURLToPath(import.meta.url)
const ROOT = join(dirname(SELF), '..', '..', '..')
// The proof's config home (scripts/lib/proofHome.ts): the inherited pin, else
// a fresh seeded scratch — never another program's directory.
const CONFIG_HOME = resolveProofHome([process.cwd()])
const VSHOT = join(ROOT, 'scripts', 'ui', 'vshot.py')

// ── child: drive the pulse store to the scene, mount the row, exit ──────────
if (process.env.PULSE_RENDER_CHILD) {
  const scene = process.env.PULSE_RENDER_CHILD
  const React = await import('react')
  const { render } = (await import('../../../src/ink.js')) as {
    render: (n: React.ReactNode) => Promise<unknown>
  }
  const { SpinnerAnimationRow } = await import(
    '../../../src/components/Spinner/SpinnerAnimationRow.js'
  )
  const pulse = await import('../../../src/utils/pulse/index.js')

  // Pinned clock: the scene's elapsed values are exact, the capture stable.
  let t = 0
  pulse.setPulseClockForTests(() => t)
  const g = pulse.beginPulseTurn()
  let mode: import('../../../src/components/Spinner/types.js').SpinnerMode = 'requesting'
  let responseLength = 0
  if (scene === 'waiting') {
    pulse.setPulsePhase(g, 'preparing', { reason: 'context' })
    t = 150
    pulse.setPulsePhase(g, 'dispatching')
    t = 300
    pulse.setPulsePhase(g, 'waiting', { model: 'Fable 5', effort: 'high' })
    t = 3700 // 3.4s in waiting
  } else {
    // stillwaiting: a responding stream whose last event is 12s old.
    pulse.setPulsePhase(g, 'dispatching')
    t = 400
    pulse.setPulsePhase(g, 'waiting', { model: 'Fable 5', effort: 'high' })
    t = 900
    pulse.setPulsePhase(g, 'responding')
    pulse.notePulseStreamActivity(g, 'text')
    t = 900 + 12_000
    mode = 'responding'
    responseLength = 400
  }

  const cols = Number(process.env.PULSE_COLS || '120')
  const ref = <T,>(v: T) => ({ current: v })
  const h = React.createElement
  void render(
    h(SpinnerAnimationRow, {
      mode,
      // reducedMotion pins the animation clock so the capture is stable; the
      // byline/attention states derive from the store, not animation.
      reducedMotion: true,
      hasActiveTools: false,
      activeToolCount: 0,
      responseLengthRef: ref(responseLength),
      message: 'Scuttling', // the verb-chain outcome (legacy prop, with no …)
      bylineVerb: 'Scuttling', // the voice that heads the waiting byline
      messageColor: scene === 'waiting' ? 'info' : 'claude',
      shimmerColor: scene === 'waiting' ? 'infoShimmer' : 'claudeShimmer',
      overrideColor: null,
      loadingStartTimeRef: ref(Date.now() - (scene === 'waiting' ? 3400 : 12_900)),
      totalPausedMsRef: ref(0),
      pauseStartTimeRef: ref<number | null>(null),
      spinnerSuffix: null,
      verbose: true,
      columns: cols,
      hasRunningTeammates: false,
      teammateTokens: 0,
      foregroundedTeammate: undefined,
      leaderIsIdle: false,
      thinkingStatus: null,
      effortSuffix: '',
      phaseBylineEligible: true,
      ttftText: scene === 'stillwaiting' ? 'ttft 0.5s' : null,
    }),
  )
  setTimeout(() => process.exit(0), 1500)
} else {
  // ── parent: vshot self at 120/80/40, assert, write PNGs ───────────────────
  let failures = 0
  const check = (label: string, cond: boolean, detail = ''): void => {
    if (!cond) failures++
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  }
  if (!existsSync(VSHOT)) {
    console.error(`vshot.py not found at ${VSHOT} — the render-verify harness (scripts/ui/vshot.py) is required.`)
    process.exit(1)
  }

  const capture = (scene: string, cols: number): { grid: string; gridPath: string } => {
    const cfg = `/tmp/vs-pulse-${scene}-${cols}.json`
    const gridPath = `/tmp/pulse-${scene}-${cols}.json`
    writeFileSync(
      cfg,
      JSON.stringify({
        argv: [process.execPath, 'run', SELF],
        sends: [],
        total: 15, // 0.2s ticks (~3s ceiling); the child exits at 1.5s → EOF-break
        cols,
        rows: 8,
        out: gridPath,
      }),
    )
    const grid = execFileSync('/usr/bin/python3', [VSHOT, cfg], {
      encoding: 'utf-8',
      timeout: 30000,
      env: {
        ...process.env,
        MERCURY_CONFIG_DIR: CONFIG_HOME,
        PULSE_RENDER_CHILD: scene,
        PULSE_COLS: String(cols),
      },
    })
    return { grid, gridPath }
  }

  console.log('============================================================')
  console.log(' PULSE spinner render-verify: phase byline + still-waiting')
  console.log('============================================================')

  const pngs: string[] = []
  for (const cols of [120, 80]) {
    console.log(`\n  ── waiting @ ${cols} ──`)
    const { grid, gridPath } = capture('waiting', cols)
    const line = grid.split('\n').find(l => /waiting/.test(l)) ?? ''
    console.log(`  row @${cols}: ${line.trim().slice(0, 76) || '(none)'}`)
    check(`@${cols}: the voice heads the byline, the phase truth rides (voice law)`, /Scuttling · waiting for Fable 5/.test(grid))
    check(`@${cols}: applied effort renders from the detail`, /· high/.test(grid))
    // the phrase carries NO
    // per-phase elapsed; the row's whole-turn timer is the single time basis
    // and renders in the trailing status parens. (This check asserted the
    // earlier 3.4s tail and had been red since that law landed.)
    check(`@${cols}: no per-phase clock in the phrase (UN-19)`, !/3\.4s/.test(grid))
    check(`@${cols}: the whole-turn timer renders in the status tail`, /\(\d+s ·/.test(grid))
    check(`@${cols}: no failure/attention vocabulary on a normal wait`, !/still waiting/.test(grid))
    const { gridToPng } = await import('../../ui/gridToPng.ts')
    const png = await gridToPng(gridPath, `/tmp/pulse-waiting-${cols}.png`)
    pngs.push(png.path)
  }
  {
    console.log('\n  ── waiting @ 40 (narrow shed) ──')
    const { grid, gridPath } = capture('waiting', 40)
    const line = grid.split('\n').find(l => /waiting/.test(l)) ?? ''
    console.log(`  row @40: ${line.trim().slice(0, 76) || '(none)'}`)
    check('@40: the byline sheds elapsed + effort (right-to-left), the voice head survives', /Scuttling · waiting for Fable 5/.test(grid) && !/3\.4s/.test(grid) && !/· high/.test(grid))
    const rows = grid.split('\n').filter(l => /waiting|high/.test(l))
    check('@40: the byline holds ONE line', rows.length === 1, `${rows.length} rows`)
    const { gridToPng } = await import('../../ui/gridToPng.ts')
    const png = await gridToPng(gridPath, '/tmp/pulse-waiting-40.png')
    pngs.push(png.path)
  }
  for (const cols of [120, 80]) {
    console.log(`\n  ── still-waiting @ ${cols} ──`)
    const { grid, gridPath } = capture('stillwaiting', cols)
    const line = grid.split('\n').find(l => /still waiting/.test(l)) ?? ''
    console.log(`  row @${cols}: ${line.trim().slice(0, 76) || '(none)'}`)
    check(`@${cols}: the quiet still-waiting suffix renders`, /still waiting/.test(grid))
    check(`@${cols}: the legacy verb carries responding (byline yields)`, /Scuttling/.test(grid))
    check(`@${cols}: the honest TTFT readout folds into the status line`, /ttft 0\.5s/.test(grid))
    const { gridToPng } = await import('../../ui/gridToPng.ts')
    const png = await gridToPng(gridPath, `/tmp/pulse-stillwaiting-${cols}.png`)
    pngs.push(png.path)
  }

  console.log('\n  PNGs: ' + pngs.join(' '))
  console.log('\n' + '='.repeat(60))
  if (failures === 0) {
    console.log(' ✅ PULSE spinner renders — byline + shed + still-waiting @120/80/40')
    process.exit(0)
  } else {
    console.log(` ❌ PULSE spinner renders — ${failures} check(s) failed`)
    process.exit(1)
  }
}
