#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPulseArena } from '../pulse/lib/pulseArena.ts'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ATTRGRAB = join(HERE, 'lib', 'attrgrab.py')
const RECEIPTS = join(HERE, 'receipts')

const ESC = String.fromCharCode(27)
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
  {
    kind: 'paced',
    deltas: WORDS.map(w => `${w}-segment `),
    gapMs: 250,
  },
  { kind: 'text', text: 'Spare.' },
]

type RunSpec = {
  name: string
  turns: ScriptedTurn[]
  dragAt: number
  origin: [number, number]
  path: [number, number][]
  end: [number, number]
  grabs: number[]
  seconds: number
  originBlank?: boolean
  originRail?: boolean
}

const specs: RunSpec[] = [
  {
    name: 'run1 first-row origin (settled)',
    turns: turnsSettled,
    dragAt: 9500,
    origin: [40, 23],
    path: [
      [60, 24],
      [70, 25],
      [78, 26],
    ],
    end: [82, 27],
    grabs: [9300, 9650, 9900, 10150, 10450, 11400, -1],
    seconds: 14,
  },
  {
    name: 'run2 middle-wrapped-row origin (settled)',
    turns: turnsSettled,
    dragAt: 9500,
    origin: [40, 26],
    path: [
      [60, 26],
      [70, 26],
      [78, 27],
    ],
    end: [82, 27],
    grabs: [9300, 9650, 9900, 10150, 10450, 11400, -1],
    seconds: 14,
  },
  {
    name: 'run3 live-growing text drag',
    turns: turnsLive,
    dragAt: 10500,
    origin: [40, 23],
    path: [
      [60, 23],
      [70, 24],
      [76, 24],
    ],
    end: [80, 25],
    grabs: [10300, 10650, 10900, 11150, 11450, 12400, -1],
    seconds: 16,
  },
  {
    name: 'run4 BLANK-row origin (the clip-band miss shape)',
    turns: turnsSettled,
    dragAt: 9500,
    origin: [40, 22],
    path: [
      [60, 23],
      [70, 24],
      [78, 25],
    ],
    end: [82, 26],
    grabs: [9300, 9650, 9900, 10150, 10450, 11400, -1],
    seconds: 14,
    originBlank: true,
  },
  {
    name: 'run5 RAIL-anchored origin escaping into the transcript',
    turns: turnsSettled,
    dragAt: 9500,
    origin: [8, 8],
    path: [
      [40, 12],
      [60, 18],
      [70, 22],
    ],
    end: [80, 24],
    grabs: [9300, 9650, 9900, 10150, 10450, 11400, -1],
    seconds: 14,
    originRail: true,
  },
]

type Frame = { atMs: number; rows: string[]; reverse: number[][]; bg: [number, number, string][] }

const lines: string[] = []
const log = (s: string): void => {
  lines.push(s)
  console.log(s)
}

log('── PR-09/PR-10 (D6) selection differential receipt ──')
log(`answer: one soft-wrapped paragraph of unique word-segments (${BODY.length} chars)`)

const frameDump: { name: string; frames: Frame[] }[] = []
let inconclusive = false

for (const spec of specs) {
  spawnSync('pbcopy', { input: 'poise-PR09-SENTINEL' })

  const dragSends = [
    `${spec.dragAt}:${press(...spec.origin)}`,
    ...spec.path.map((p, i) => `${spec.dragAt + 250 * (i + 1)}:${move(...p)}`),
    `${spec.dragAt + 250 * (spec.path.length + 1)}:${move(...spec.end)}`,
    `${spec.dragAt + 250 * (spec.path.length + 1) + 350}:${release(...spec.end)}`,
  ]

  const run = await runPulseArena({
    turns: spec.turns,
    sends: ['2000:\\r', '6000:selection probe\\r', ...dragSends],
    seconds: spec.seconds,
    cols: 120,
    rows: 40,
    keep: true,
  })

  const grab = spawnSync(
    '/usr/bin/python3',
    [ATTRGRAB, run.paths.drive, '120', '40', ...spec.grabs.map(String)],
    { encoding: 'utf8' },
  )
  if (grab.status !== 0) {
    console.error(`attrgrab failed for ${spec.name}: ${grab.stderr}`)
    inconclusive = true
    run.cleanup()
    continue
  }
  const { screens } = JSON.parse(grab.stdout) as { screens: Frame[] }
  frameDump.push({ name: spec.name, frames: screens })

  const copied = spawnSync('pbpaste', { encoding: 'utf8' }).stdout

  const preDrag = screens[0]
  const bodyRows = preDrag.rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => /-segment/.test(r))
    .map(({ i }) => i)
  const originRow0 = spec.origin[1] - 1
  if (spec.originBlank) {
    const rowText = (preDrag.rows[originRow0] ?? '').slice(26, 118).trim()
    if (rowText !== '') {
      log('')
      log(`━━ ${spec.name} ━━`)
      log(`  INCONCLUSIVE: origin row ${spec.origin[1]} is not blank ("${rowText.slice(0, 40)}")`)
      inconclusive = true
      run.cleanup()
      continue
    }
  } else if (spec.originRail) {
  } else if (!bodyRows.includes(originRow0)) {
    log('')
    log(`━━ ${spec.name} ━━`)
    log(
      `  INCONCLUSIVE: drag origin row ${spec.origin[1]} (1-based) not a body row; body rows (0-based): ${bodyRows.join(',')}`,
    )
    inconclusive = true
    run.cleanup()
    continue
  }

  const key = (c: number[]): string => `${c[0]},${c[1]}`
  const { getTheme: getTheme09 } = await import('../../src/utils/theme.js')
  const _rgb09 = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(String(getTheme09('dark').selectionBg))
  const SEL_BG = _rgb09
    ? _rgb09.slice(1).map(n => Number(n).toString(16).padStart(2, '0')).join('')
    : String(getTheme09('dark').selectionBg).replace('#', '').replace('ansi:', '').toLowerCase()
  const preReverse = new Set(preDrag.reverse.map(key))
  const preBg = new Map(preDrag.bg.map(([x, y, col]) => [`${x},${y}`, col]))
  const midFrames = screens.filter(s => s.atMs !== -1 && s.atMs > spec.grabs[0])
  const overlayCells = new Map<string, [number, number]>()
  for (const f of midFrames) {
    for (const c of f.reverse) {
      const k = key(c)
      if (!preReverse.has(k)) overlayCells.set(k, [c[0]!, c[1]!])
    }
    for (const [x, y, col] of f.bg) {
      if (col === SEL_BG && preBg.get(`${x},${y}`) !== col) overlayCells.set(`${x},${y}`, [x, y])
    }
  }
  const overlay = [...overlayCells.values()]
  const overlayRows = [...new Set(overlay.map(([, y]) => y))].sort((a, b) => a - b)
  const overlayMinX = overlay.length ? Math.min(...overlay.map(([x]) => x)) : -1
  const overlayMaxX = overlay.length ? Math.max(...overlay.map(([x]) => x)) : -1
  const railOverlap = overlay.filter(([x]) => x <= 24)

  const copiedChanged = copied !== 'poise-PR09-SENTINEL'
  const railGlyphInCopy = /[│╭╰╮╯]/.test(copied)
  const railTextInCopy = /(SEAT|CREW|TASKS|TABULA|TELEMETRY|lanes)/.test(copied)
  const newlines = (copied.match(/\n/g) ?? []).length
  const copiedWords = WORDS.filter(w => copied.includes(`${w}-segment`))

  log('')
  log(`━━ ${spec.name} ━━`)
  log(`  body rows (0-based): ${bodyRows.join(',')} · drag ${spec.origin.join(',')} -> ${spec.end.join(',')} (1-based SGR)`)
  log(`  overlay: ${overlay.length} new attr cells · rows ${overlayRows.join(',')} · x∈[${overlayMinX},${overlayMaxX}]`)
  log(`  overlay cells in the left rail (x<=24): ${railOverlap.length}`)
  log(`  clipboard changed: ${copiedChanged} · bytes: ${Buffer.byteLength(copied, 'utf8')} · code units: ${copied.length}`)
  log(`  rail border glyphs in copy: ${railGlyphInCopy} · rail lane text in copy: ${railTextInCopy}`)
  log(`  newlines in copy: ${newlines} (soft-wrapped source has none)`)
  log(`  copied word-segments: ${copiedWords.length ? `${copiedWords[0]}..${copiedWords[copiedWords.length - 1]} (${copiedWords.length})` : 'none'}`)
  log(`  copied preview: ${JSON.stringify(copied.slice(0, 160))}`)
  run.cleanup()
}

for (const { name, frames } of frameDump) {
  lines.push(`\n════════ ${name} — frames ════════`)
  for (const s of frames) {
    lines.push(`\n════ screen @${s.atMs}ms · reverse=${s.reverse.length} bg=${s.bg.length} ════`)
    lines.push(s.rows.filter(r => r.trim() !== '').join('\n'))
  }
}

mkdirSync(RECEIPTS, { recursive: true })
writeFileSync(join(RECEIPTS, 'pr09-pr10-head-6fe78a3d.txt'), lines.join('\n'))
console.log('\nreceipt: scripts/render-continuity/receipts/pr09-pr10-head-6fe78a3d.txt')
process.exit(inconclusive ? 2 : 0)
