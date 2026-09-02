#!/usr/bin/env bun
// ============================================================================
//  scripts/attention/prove-c3-resize-stream.ts — the
//  STREAMING-resize journey on the SHIPPED artifact.
//
//  The row's contract: wide → canonical → narrow → canonical WHILE a real
//  turn streams — no blank frame, no stale mascot, no geometry jump, no
//  dropped tail, no unwanted activation. One hermetic app-scale arena run
//  (flux's artifactArena: real dist under a PTY, paced fixture streaming,
//  TIOCSWINSZ+SIGWINCH resizes mid-stream, screens reconstructed from the
//  byte log via pyte):
//
//    140×40 boot → prompt → ~5 s paced stream; resizes at 6.5 s (140→120),
//    8 s (120→100×30, the viewport floor), 9.5 s (100→120×40) — all inside the stream — then the
//    stream finishes and settles.
//
//  Evidence screens are written to docs/benchmarks/rendezvous/c3/ by the
//  --emit-evidence flag (the committed artifact the acceptance row cites).
//
//  Requires a CURRENT dist/mercury.mjs (the pooled gate prebuilds Phase 0).
// ============================================================================
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checker } from '../engine-durability/harness.ts'
import { runArtifactArena, grabScreens, requireDist } from '../streaming/artifactArena.ts'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

const t = checker()
requireDist()

const MASCOT = '▖▟▆▙▗'
const EMIT = process.argv.includes('--emit-evidence')

// ~100 numbered lines at gapMs 50 ≈ 5 s of streaming, taller than the
// viewport at every geometry this journey visits.
const deltas: string[] = []
for (let i = 0; i < 100; i++) deltas.push(`rv-stream-line-${String(i).padStart(3, '0')}\n`)
const LAST_NEEDLE = 'rv-stream-line-099'

const run = await runArtifactArena({
  turns: [{ kind: 'paced', deltas, gapMs: 50, settleDelayMs: 1200 }],
  sends: ['4500:stream the rendezvous journey', '5300:\\r'],
  resizes: ['6500:120:40', '8000:100:30', '9500:120:40'],
  seconds: 15,
  cols: 140,
  rows: 40,
  keep: true,
})

const flat = (rows: string[]): string => rows.join('\n')

/** The stale-mascot law, surface-true: the brand mark legitimately lives on
 *  TWO surfaces (the header box and the bottom statusline) — both may be on
 *  screen at once at short geometries. Staleness = the SAME surface painted
 *  twice, or a mascot fragment on no surface at all. */
function mascotSurfaceViolations(rows: string[]): string {
  let headers = 0
  let statuslines = 0
  let stray = 0
  for (const row of rows) {
    if (!row.includes(MASCOT)) continue
    if (row.includes('· ctx ')) headers++
    else if (row.includes('⤳') || row.includes('│')) statuslines++
    else stray++
  }
  const problems: string[] = []
  if (headers > 1) problems.push(`${headers} header rows`)
  if (statuslines > 1) problems.push(`${statuslines} statusline rows`)
  if (stray > 0) problems.push(`${stray} stray mascot fragment(s)`)
  return problems.join(', ')
}

t.section('§1 the stream survived three mid-flight geometry changes')
{
  t.check(
    'the fixture streamed fully (every delta emitted)',
    run.fixture.pacedEmits.length === deltas.length,
    `${run.fixture.pacedEmits.length}/${deltas.length}`,
  )
  const fin = grabScreens(run, 120, 40, [-1])[0]!
  const finText = flat(fin.rows)
  t.check('the final screen (canonical 120) shows the stream tail — no dropped content', finText.includes(LAST_NEEDLE))
  const violations = mascotSurfaceViolations(fin.rows)
  t.check('no stale mascot (each brand surface painted at most once)', violations === '', violations)
  t.check('the composer is at rest — no unwanted activation', finText.includes('? for shortcuts'))
  const widest = Math.max(...fin.rows.map(r => r.trimEnd().length))
  t.check(
    `the canonical geometry took (content re-lays past col 100: widest=${widest})`,
    widest > 100,
  )
  if (EMIT) {
    const dir = join(tmpdir(), 'rendezvous-c3')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'resize-stream-final-120.txt'), finText + '\n')
  }
}

t.section('§2 no blank frame in any resize phase (screens sampled mid-log)')
{
  // Each sample sits inside its phase, reconstructed AT that phase's
  // geometry — the repaint the resize triggers must show real content,
  // never a cleared void. INSTRUMENT BOUNDARY, learned live: a mid-log
  // replay at a geometry the EARLIER bytes did not assume is a collage
  // (pyte wraps the pre-resize bytes; the real emulator reflows on
  // SIGWINCH) — so these legs claim CONTENT PRESENCE only; precise layout
  // claims (mascot count) are made at SETTLED geometry boundaries (§1, §3).
  const phases: Array<{ label: string; cols: number; rows: number; atMs: number }> = [
    { label: 'wide 140 pre-resize (streaming)', cols: 140, rows: 40, atMs: 6200 },
    { label: 'canonical 120 (streaming)', cols: 120, rows: 40, atMs: 7200 },
    { label: 'narrow 100×30 (streaming)', cols: 100, rows: 30, atMs: 8800 },
    { label: 'canonical return 120 (streaming)', cols: 120, rows: 40, atMs: 10_300 },
  ]
  for (const phase of phases) {
    const screen = grabScreens(run, phase.cols, phase.rows, [S(phase.atMs)])[0]!
    const text = flat(screen.rows)
    const glyphs = text.replace(/\s/g, '').length
    t.check(
      `${phase.label}: the frame is painted (${glyphs} glyphs, stream content visible)`,
      glyphs > 100 && /rv-stream-line-\d{3}/.test(text),
      glyphs <= 100 ? 'near-blank frame' : 'no stream content on screen',
    )
  }
}

run.cleanup()

t.section('§3 the narrow geometry SETTLED truth (a run that ends at 100×30, the viewport floor)')
{
  // The faithful stale-mascot instrument: the journey's narrow leg gets its
  // own run that streams THROUGH the shrink and settles there — the final
  // screen is a true 100×30 frame (the viewport floor), not a replay collage.
  const run80 = await runArtifactArena({
    turns: [{ kind: 'paced', deltas, gapMs: 50, settleDelayMs: 1200 }],
    sends: ['4500:stream the rendezvous journey', '5300:\\r'],
    resizes: ['6500:120:40', '8000:100:30'],
    seconds: 15,
    cols: 140,
    rows: 40,
    keep: true,
  })
  t.check(
    'the narrow-settle run streamed fully',
    run80.fixture.pacedEmits.length === deltas.length,
    `${run80.fixture.pacedEmits.length}/${deltas.length}`,
  )
  const fin = grabScreens(run80, 100, 30, [-1])[0]!
  const text = flat(fin.rows)
  t.check('the settled 100×30 screen shows the stream tail', text.includes(LAST_NEEDLE))
  const violations = mascotSurfaceViolations(fin.rows)
  t.check(
    'no stale mascot at the settled narrow geometry (header + statusline both legitimately visible, each once)',
    violations === '',
    violations,
  )
  t.check('the composer is at rest at 100×30', text.includes('? for shortcuts'))
  const widest = Math.max(...fin.rows.map(r => r.trimEnd().length))
  t.check(`the narrow geometry took (widest row ${widest} ≤ 100)`, widest <= 100)
  if (EMIT) {
    writeFileSync(join('docs/benchmarks/rendezvous/c3', 'resize-stream-narrow-100.txt'), text + '\n')
  }
  run80.cleanup()
}

t.finish('prove-c3-resize-stream')
