#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { runPulseArena, anchoredOffset } = await import('./lib/pulseArena.ts')
const { checker } = await import('../engine-durability/harness.ts')
type ScriptedTurn = import('../lib/fixtureApi.ts').ScriptedTurn

const HERE = dirname(fileURLToPath(import.meta.url))
const ATTRGRAB = join(HERE, 'lib', 'attrgrab.py')

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
  dragAfter?: string
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
    origin: [48, 11],
    path: [[60, 12], [70, 13], [78, 14]],
    end: [82, 15],
    seconds: 14,
    kind: 'transcript',
  },
  {
    name: 'run2 middle-wrapped origin',
    turns: turnsSettled,
    dragAt: 9500,
    origin: [40, 16],
    path: [[60, 16], [70, 16], [78, 17]],
    end: [82, 17],
    seconds: 14,
    kind: 'transcript',
  },
  {
    name: 'run3 live-growing drag',
    turns: turnsLive,
    dragAt: 10500,
    dragAfter: `${WORDS[11]}-segment`,
    origin: [40, 11],
    path: [[60, 11], [70, 12], [76, 12]],
    end: [80, 13],
    seconds: 16,
    kind: 'transcript',
  },
  {
    name: 'run4 blank-row origin',
    turns: turnsSettled,
    dragAt: 9500,
    origin: [40, 10],
    path: [[60, 11], [70, 12], [78, 13]],
    end: [82, 14],
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
    origin: [82, 15],
    path: [[78, 14], [70, 13], [60, 12]],
    end: [48, 11],
    seconds: 14,
    kind: 'transcript',
  },
]

const CJK_BODY = '宽字formation字符 network 测试ablation 环境matrix 稳定alignment 输出framework.'
const turnsCjk: ScriptedTurn[] = [
  { kind: 'paced', deltas: [CJK_BODY], gapMs: 100 },
  { kind: 'text', text: 'Spare.' },
]

type Frame = { atMs: number; rows: string[]; reverse: number[][]; bg: [number, number, string][] }
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
  origin: [46, 11],
  path: [[60, 11], [90, 11]],
  end: [112, 11],
  seconds: 14,
  kind: 'cjk' as never,
})
specs.push({
  name: 'run8 resize mid-selection clears cleanly',
  turns: turnsSettled,
  dragAt: 9500,
  origin: [40, 16],
  path: [[60, 17], [70, 18]],
  end: [82, 19],
  seconds: 16,
  kind: 'resize' as never,
})

const activeSpecs = process.env.POISE_ONLY_RAIL ? specs.filter(sp => sp.kind === 'rail') : specs
for (const spec of activeSpecs) {
  const gesture: [number, string][] = [
    [0, press(...spec.origin)],
    ...spec.path.map((p, i): [number, string] => [250 * (i + 1), move(...p)]),
    [250 * (spec.path.length + 1), move(...spec.end)],
    [250 * (spec.path.length + 1) + 350, release(...spec.end)],
    ...(spec.kind === 'resize' ? [[2600, `${press(30, 12)}${release(30, 12)}`] as [number, string]] : []),
  ]
  const dragSends = gesture.map(([offset, payload]) => (spec.dragAfter === undefined ? `${spec.dragAt + offset}:${payload}` : `after:${spec.dragAfter}:${offset}:${payload}`))
  const run = await runPulseArena({
    turns: spec.turns,
    sends: ['2000:\\r', '6000:selection probe\\r', ...dragSends],
    seconds: spec.seconds,
    cols: 120,
    rows: 40,
    keep: true,
    extraEnv: { ...OSC52_ENV, COLORTERM: 'truecolor' },
  })
  const pressAt = ((): number => {
    if (spec.dragAfter === undefined) return anchoredOffset(run, S(spec.dragAt))
    const records = readFileSync(run.paths.drive, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { ts?: number; sent?: number; after?: string })
    const firstOutput = records.find(r => typeof r.ts === 'number')?.ts
    const pressed = records.find(r => typeof r.sent === 'number' && r.after === spec.dragAfter)?.sent
    return firstOutput === undefined || pressed === undefined ? -1 : pressed - firstOutput
  })()
  const grab = spawnSync(
    '/usr/bin/python3',
    [ATTRGRAB, run.paths.drive, '120', '40', String(pressAt - S(200)), String(pressAt + S(650)), String(pressAt + S(1150)), '-1'],
    { encoding: 'utf8' },
  )
  t.section(spec.name)
  if (spec.dragAfter !== undefined) t.check(`the drag pressed once ${spec.dragAfter} had painted (the body's third row exists while the text still streams)`, pressAt > 0, pressAt > 0 ? `pressed @${pressAt}` : 'the press has no record in the drive')
  if (grab.status !== 0) {
    t.check('attrgrab ran', false, grab.stderr)
    run.cleanup()
    continue
  }
  const { screens, copies, copyFacts } = JSON.parse(grab.stdout) as Grab
  const pre = screens[0]
  const key = (c: number[]): string => `${c[0]},${c[1]}`
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
