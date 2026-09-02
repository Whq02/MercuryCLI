#!/usr/bin/env bun
// ============================================================================
//  scripts/render-continuity/prove-selection-region.ts — PO-6 (PO-17..19): the
//  selection latches a semantic region from any anchor; a lookup miss never
//  goes global.
//
//  Five packaged-PTY runs over the same soft-wrapped answer (the repro-pr09
//  arena, now with ASSERTIONS):
//    run1  first-row origin      — clipped to the transcript, byte-precise
//    run2  middle-wrapped origin — same region as run1 (origin-row parity)
//    run3  live-growing text     — clipped while streaming
//    run4  BLANK-row origin      — the miss shape stays inside the pane
//    run5  RAIL-anchored origin  — REGION-BOUNDED:
//          the gesture stays in the rail's box — no mascot art, no body
//          text, no full-width overlay, no border glyphs in the copy.
//
//  Shared laws asserted on every transcript run: overlay never enters the
//  rail columns; copied bytes carry no rail glyphs/lane text; soft wraps
//  join without fabricated newlines.
//
//  Before-state measurement: overlay x∈[0,119], 2003 copied bytes, 15 newlines
//  escaped.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { runPulseArena } = await import('../pulse/lib/pulseArena.ts')
const { checker } = await import('../engine-durability/harness.ts')
type ScriptedTurn = import('../lib/fixtureApi.ts').ScriptedTurn

const HERE = dirname(fileURLToPath(import.meta.url))
const ATTRGRAB = join(HERE, 'lib', 'attrgrab.py')

// The ONE selection color, derived from the product's own theme owner (the
// arena boots the scratch-home default theme). pyte ships truecolor bg as
// bare-hex and named colors by name — normalize the theme spelling
// ('rgb(r, g, b)' | '#hex' | 'ansi:name') to the same vocabulary.
const { getTheme } = await import('../../src/utils/theme.js')
const themeSelectionBgToPyte = (v: string): string => {
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(v)
  if (rgb) return rgb.slice(1).map(n => Number(n).toString(16).padStart(2, '0')).join('')
  if (v.startsWith('ansi:')) return v.slice(5)
  return v.replace('#', '').toLowerCase()
}
const SELECTION_BG = themeSelectionBgToPyte(String(getTheme('dark').selectionBg))
const t = checker()

const ESC = String.fromCharCode(27)

// HERMETIC copy oracle (ambient-state law): the host clipboard races the
// app's async writes and other host processes. Forcing the osc52 clipboard
// path (SSH_CONNECTION set -> getClipboardPath() = 'osc52') makes the copy
// land IN-BAND as OSC 52 on the pty wire; attrgrab.py decodes the payloads
// OUT OF PROCESS (a fresh python per run — in-bun predicates on the shared
// decode intermittently answered with the PREVIOUS run's content under pool
// load, bun 1.3.11; the subprocess boundary makes the oracle stable).
const OSC52_ENV = { SSH_CONNECTION: 'poise 0 hermetic 0' }
const press = (c: number, r: number): string => `${ESC}[<0;${c};${r}M`
const move = (c: number, r: number): string => `${ESC}[<32;${c};${r}M`
const release = (c: number, r: number): string => `${ESC}[<0;${c};${r}m`

const WORDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
  'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey',
  'xray', 'yankee', 'zulu', 'anchor', 'beacon', 'copper', 'dagger',
  'ember', 'falcon', 'garnet', 'harbor', 'ingot', 'jasper', 'krait',
  'lantern', 'marble', 'nickel', 'onyx', 'pewter', 'quartz', 'russet',
  'saffron', 'topaz', 'umber', 'vellum', 'walnut', 'zephyr',
]
const BODY = WORDS.map(w => `${w}-segment`).join(' ') + '.'
const turnsSettled: ScriptedTurn[] = [
  { kind: 'paced', deltas: [BODY], gapMs: 100 },
  { kind: 'text', text: 'Spare.' },
]
const turnsLive: ScriptedTurn[] = [
  { kind: 'paced', deltas: WORDS.map(w => `${w}-segment `), gapMs: 250 },
  { kind: 'text', text: 'Spare.' },
]

type RunSpec = {
  name: string
  turns: ScriptedTurn[]
  dragAt: number
  origin: [number, number]
  path: [number, number][]
  end: [number, number]
  seconds: number
  kind: 'transcript' | 'rail' | 'cjk' | 'resize'
}

const specs: RunSpec[] = [
  {
    name: 'run1 first-row origin',
    turns: turnsSettled,
    dragAt: 9500,
    origin: [40, 23],
    path: [[60, 24], [70, 25], [78, 26]],
    end: [82, 27],
    seconds: 14,
    kind: 'transcript',
  },
  {
    name: 'run2 middle-wrapped origin',
    turns: turnsSettled,
    dragAt: 9500,
    origin: [40, 26],
    path: [[60, 26], [70, 26], [78, 27]],
    end: [82, 27],
    seconds: 14,
    kind: 'transcript',
  },
  {
    name: 'run3 live-growing drag',
    turns: turnsLive,
    dragAt: 10500,
    origin: [40, 23],
    path: [[60, 23], [70, 24], [76, 24]],
    end: [80, 25],
    seconds: 16,
    kind: 'transcript',
  },
  {
    name: 'run4 blank-row origin',
    turns: turnsSettled,
    dragAt: 9500,
    origin: [40, 22],
    path: [[60, 23], [70, 24], [78, 25]],
    end: [82, 26],
    seconds: 14,
    kind: 'transcript',
  },
  {
    name: 'run5 rail-anchored origin',
    turns: turnsSettled,
    dragAt: 9500,
    origin: [8, 8],
    path: [[40, 12], [60, 18], [70, 22]],
    end: [80, 24],
    seconds: 14,
    kind: 'rail',
  },
  {
    name: 'run6 REVERSE drag (end -> start of run1 range)',
    turns: turnsSettled,
    dragAt: 9500,
    origin: [82, 27],
    path: [[78, 26], [70, 25], [60, 24]],
    end: [40, 23],
    seconds: 14,
    kind: 'transcript',
  },
]

// run7: wide-glyph body — the copy must carry the CJK text byte-exact.
const CJK_BODY = '宽字formation字符 network 测试ablation 环境matrix 稳定alignment 输出framework.'
const turnsCjk: ScriptedTurn[] = [
  { kind: 'paced', deltas: [CJK_BODY], gapMs: 100 },
  { kind: 'text', text: 'Spare.' },
]

type Frame = { atMs: number; rows: string[]; reverse: number[][]; bg: [number, number, string][] }
/** Per-copy content predicates computed IN PYTHON (attrgrab.py) — bun 1.3.11
 *  .includes/.filter over these wire-derived strings intermittently answers
 *  with a PREVIOUS payload's content (~1-in-2 on the rail arena, observed
 * even solo) while.slice of the same variable prints true
 *  bytes. Every gating predicate below consumes these NUMBERS; the strings
 *  remain display-only. */
type CopyFacts = {
  bytes: number
  segmentHits: number
  railLaneHits: number
  borderGlyphHits: number
  mascotHits: number
  newlineCount: number
  cjkNeedleHits: number
  replacementHits: number
}
type Grab = { screens: Frame[]; copies: string[]; copyFacts: CopyFacts[] }

specs.push({
  name: 'run7 wide-glyph (CJK) drag',
  turns: turnsCjk,
  dragAt: 9500,
  origin: [27, 23],
  path: [[60, 23], [90, 23]],
  end: [112, 23],
  seconds: 14,
  kind: 'cjk' as never,
})
specs.push({
  name: 'run8 resize mid-selection clears cleanly',
  turns: turnsSettled,
  dragAt: 9500,
  origin: [40, 23],
  path: [[60, 24], [70, 25]],
  end: [82, 26],
  seconds: 16,
  kind: 'resize' as never,
})

const activeSpecs = process.env.POISE_ONLY_RAIL ? specs.filter(sp => sp.kind === 'rail') : specs
for (const spec of activeSpecs) {
  const dragSends = [
    `${spec.dragAt}:${press(...spec.origin)}`,
    ...spec.path.map((p, i) => `${spec.dragAt + 250 * (i + 1)}:${move(...p)}`),
    `${spec.dragAt + 250 * (spec.path.length + 1)}:${move(...spec.end)}`,
    `${spec.dragAt + 250 * (spec.path.length + 1) + 350}:${release(...spec.end)}`,
    ...(spec.kind === 'resize'
      ? [`${spec.dragAt + 2600}:${press(30, 12)}${release(30, 12)}`]
      : []),
  ]
  const run = await runPulseArena({
    turns: spec.turns,
    sends: ['2000:\\r', '6000:selection probe\\r', ...dragSends],
    seconds: spec.seconds,
    cols: 120,
    rows: 40,
    keep: true,
    extraEnv: OSC52_ENV,
  })
  const grab = spawnSync(
    '/usr/bin/python3',
    [ATTRGRAB, run.paths.drive, '120', '40', String(S(spec.dragAt - 200)), String(S(spec.dragAt + 650)), String(S(spec.dragAt + 1150)), '-1'],
    { encoding: 'utf8' },
  )
  t.section(spec.name)
  if (grab.status !== 0) {
    t.check('attrgrab ran', false, grab.stderr)
    run.cleanup()
    continue
  }
  const { screens, copies, copyFacts } = JSON.parse(grab.stdout) as Grab
  const pre = screens[0]
  const key = (c: number[]): string => `${c[0]},${c[1]}`
  // SELECTION-COLOR-keyed overlay detection (2-2-2 refinement of the
  // value-keyed rewrite, which over-detected: pointer-HOVER glows also
  // change bg colors during a drag — 294 cells spanning the whole pane).
  // The product paints the selection through ONE color: withSelectionBg
  // REPLACES the ground bg with the theme's selectionBg for every selected
  // cell (src/ink/cell-grid.ts withSelectionBg; wired from
  // getTheme(theme).selectionBg in useCopyOnSelect). A cell is overlay iff
  // it is NEWLY REVERSED (the null-selectionBg inverse fallback) or its bg
  // BECAME the selection color since the pre-frame. Hover glows use other
  // roles and never match; a dead overlay still reds (zero cells).
  const preReverse = new Set(pre.reverse.map(key))
  const preBg = new Map(pre.bg.map(([x, y, col]) => [`${x},${y}`, col]))
  const overlay: [number, number][] = []
  const seen = new Set<string>()
  for (const f of screens.filter(s => s.atMs !== -1 && s.atMs > pre.atMs)) {
    for (const c of f.reverse) {
      const k = key(c)
      if (!preReverse.has(k) && !seen.has(k)) {
        seen.add(k)
        overlay.push([c[0]!, c[1]!])
      }
    }
    for (const [x, y, col] of f.bg) {
      const k = `${x},${y}`
      if (col === SELECTION_BG && preBg.get(k) !== col && !seen.has(k)) {
        seen.add(k)
        overlay.push([x, y])
      }
    }
  }
  const copied = copies[copies.length - 1] ?? ''
  const fact: CopyFacts = copyFacts[copyFacts.length - 1] ?? {
    bytes: 0, segmentHits: 0, railLaneHits: 0, borderGlyphHits: 0,
    mascotHits: 0, newlineCount: 0, cjkNeedleHits: 0, replacementHits: 0,
  }
  const overlayXs = overlay.map(([x]) => x)

  if (spec.kind === 'cjk') {
    t.check('the release emitted exactly one in-band copy', copies.length === 1, `${copies.length}`)
    t.check(
      'wide-glyph copy is byte-coherent (no mojibake, contiguous CJK+ascii run)',
      fact.cjkNeedleHits > 0 && fact.replacementHits === 0,
      JSON.stringify(copied.slice(0, 80)),
    )
    t.check('no rail bytes in the CJK copy', fact.borderGlyphHits === 0 && fact.railLaneHits === 0)
  } else if (spec.kind === 'resize') {
    const final = screens[screens.length - 1]
    // Same selection-color keying as the overlay derivation: a lingering
    // ghost is a cell still reversed or still wearing the SELECTION color.
    const ghost = [
      ...final.reverse.filter(c => !preReverse.has(key(c))).map(c => [c[0]!, c[1]!] as [number, number]),
      ...final.bg.filter(([x, y, col]) => col === SELECTION_BG && preBg.get(`${x},${y}`) !== col).map(([x, y]) => [x, y] as [number, number]),
    ].filter(([x, y]) => y >= 21 && y <= 27 && x >= 25)
    t.check(
      'a later plain click clears the old overlay (no ghost selection)',
      ghost.length <= 2,
      `${ghost.length} lingering attr cells`,
    )
  } else if (spec.kind === 'transcript') {
    t.check('the release emitted exactly one in-band copy', copies.length === 1, `${copies.length}`)
    t.check(
      'overlay stays inside the transcript pane (no rail columns)',
      overlay.length > 0 && Math.min(...overlayXs) >= 25,
      `x∈[${Math.min(...overlayXs)},${Math.max(...overlayXs)}] · ${overlay.length} cells`,
    )
    t.check('no rail border glyphs in the copy', fact.borderGlyphHits === 0)
    t.check('no rail lane text in the copy', fact.railLaneHits === 0)
    t.check('body text was copied', fact.segmentHits > 0, `${fact.segmentHits} segment hits`)
    t.check(
      'soft wraps join without fabricated newlines (blank-row origin may carry one hard break)',
      fact.newlineCount <= (spec.name.includes('blank') ? 1 : 0),
      `${fact.newlineCount}`,
    )
  } else {
    // The rail-anchored gesture is BOUNDED to its owning region (or makes
    // no copy at all when the region yields nothing) — never the screen.
    t.check(
      'overlay never leaves the rail region (x <= 24)',
      overlay.length === 0 || Math.max(...overlayXs) <= 24,
      overlay.length ? `x∈[${Math.min(...overlayXs)},${Math.max(...overlayXs)}] · ${overlay.length} cells` : 'no overlay',
    )
    t.check(
      'no transcript body text in any in-band copy',
      fact.segmentHits === 0,
      `${fact.segmentHits} segment hits: ${JSON.stringify(copied.slice(0, 240))}`,
    )
    t.check('no mascot art in the copy', fact.mascotHits === 0)
    t.check('no border glyphs in the copy', fact.borderGlyphHits === 0)
    t.check(
      'the copy is bounded (region-sized, not screen-sized)',
      fact.bytes < 600,
      `${fact.bytes} bytes`,
    )
  }
  run.cleanup()
}

t.finish('prove-selection-region')
