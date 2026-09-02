#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-journey-width-matrix.ts — + +
//  in the BUILT binary.
//
//  Static arenas at 44 / 80 / 160 columns (each booted AT that width, so the
//  pyte replay is geometry-true): the card retains the question, both
//  options, the preview frame, the notes affordance, and the footer at every
//  width; wide glyphs and combining marks render; the long unbroken preview
//  line is CLIPPED, never overflowed. 120 is pinned continuously by the
//  five behavior journeys.
//
//  The resize cycle (120 → 80 → 44 → 160 → 120) asserts SEMANTIC
//  preservation on its geometry-true phases: the note, the focused option,
//  and the information set present at the first 120-col paint are all
//  present after the full cycle — no reversion to an older state. (Mid-cycle
//  phases are asserted by the static arenas; a fixed-geometry replay of a
//  resized log garbles, which is a replay artifact, not product truth.)
//
//  The height arena: a 48-line preview at rows=30 keeps the QUESTION AND
//  CONTROLS on screen with an explicit truncation bar (law B2 very-short).
//
//  Requires the prebuilt dist (the pooled gate prebuilds it in Phase 0).
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import {
  findRows,
  firstOutputTs,
  grabScreens,
  requireDist,
  runArtifactArena,
  type GrabbedScreen,
} from '../streaming/artifactArena.ts'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { checker } from '../engine-durability/harness.ts'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

const t = checker()
requireDist()

const UNBROKEN = 'x'.repeat(200)
const RICH_PREVIEW = [
  '### 日本語の見出し — the layered café',
  '',
  '| key | 値 |',
  '|-----|----|',
  '| ttl | 300 |',
  '',
  '```ts',
  "const café = 'naïve'",
  '```',
  '',
  UNBROKEN,
].join('\n')

// The rich content rides the FOCUSED option's preview — the journeys focus
// 'Flat', and only the focused preview paints.
const QUESTION = {
  question: 'Which config shape should ship?',
  header: 'Config',
  options: [
    { label: 'Layered', description: 'Defaults merged per root.', preview: '### Layered\n\n```ts\nmerge(defaults, local)\n```' },
    { label: 'Flat', description: 'One frozen constant.', preview: RICH_PREVIEW },
  ],
}

const TURNS: ScriptedTurn[] = [
  { kind: 'tool_use', name: 'AskUserQuestion', input: { questions: [QUESTION] }, id: 'auq_w', preText: 'One decision remains open.' },
  { kind: 'text', text: 'Understood.' },
]

const SENDS = [
  '8000:design the config layer',
  '8800:\r',
  '12500:\x1b[B', // focus 'Flat' — its rich preview paints
  '13000:n',
  '13500:keep flat',
  '14300:\x1b', // leave notes — the note is the semantic marker
]

const textOf = (s: GrabbedScreen): string => s.rows.join('\n')

function assertWidth(name: string, s: GrabbedScreen): void {
  t.section(`§${name} — all required information present`)
  const text = textOf(s)
  t.check('the question is on screen', text.includes('Which config shape should ship?'))
  t.check('both option labels are on screen', text.includes('Layered') && text.includes('Flat'))
  const cardTop = findRows(s.rows, 'Which config shape')[0] ?? 0
  const pointer = findRows(s.rows, '❯').filter(r => r >= cardTop)
  const flat = findRows(s.rows, 'Flat').filter(r => r >= cardTop)
  t.check('the focused pointer sits on Flat', pointer.some(r => flat.includes(r)), `p@${pointer.join(',')}`)
  t.check('the note survived on screen', text.includes('keep flat'))
  t.check('the preview frame paints', text.includes('┌') && text.includes('└'))
  t.check('the discussion footer is reachable on screen', text.includes('Chat about this'))
  t.check('the long unbroken line is CLIPPED, never overflowed', !text.includes(UNBROKEN))
  t.check('wide-glyph content renders', text.includes('日本語') || text.includes('値'))
}

// ── static widths (each booted AT its geometry — replay-true) ───────────────
for (const cols of [80, 160]) {
  const run = await runArtifactArena({
    turns: TURNS,
    sends: SENDS,
    seconds: 17,
    cols,
    rows: 44,
    probe: false,
    keep: true,
  })
  try {
    void firstOutputTs(run)
    assertWidth(`static-${cols}`, grabScreens(run, cols, 44, [S(15_600)])[0]!)
  } finally {
    run.cleanup()
  }
}

// ── the narrow width: reached by a resize from the cockpit width ──────────
// The Boot face the arena lands on has no menu below its ratified 64×13
// floor (splash-core MENU_FLOOR_COLS), so the landing press has no row to
// press and a boot AT 44 columns never opens the chat. The card's
// completeness at 44 is graded after a resize from 120: the same laws,
// read from the settled narrow frame.
{
  const narrow = await runArtifactArena({
    turns: TURNS,
    sends: SENDS,
    resizes: ['15200:44:44'],
    seconds: 19,
    cols: 120,
    rows: 44,
    probe: false,
    keep: true,
  })
  try {
    void firstOutputTs(narrow)
    assertWidth('resized-44', grabScreens(narrow, 44, 44, [S(16_600)])[0]!)
  } finally {
    narrow.cleanup()
  }
}

// ── the resize cycle: semantic preservation across 120→80→44→160→120 ───────
const cycle = await runArtifactArena({
  turns: TURNS,
  sends: SENDS,
  resizes: ['15200:80:44', '16500:44:44', '17800:160:44', '19100:120:44'],
  seconds: 22,
  cols: 120,
  rows: 44,
  probe: false,
  keep: true,
})
try {
  void firstOutputTs(cycle)
  const first = grabScreens(cycle, 120, 44, [S(14_900)])[0]!
  const back = grabScreens(cycle, 120, 44, [-1])[0]!
  t.section('§resize — the full cycle preserves semantic state at return')
  const key = (x: string): string =>
    ['Which config shape', 'Layered', 'Flat', 'keep flat', 'Chat about this']
      .map(n => (x.includes(n) ? '1' : '0'))
      .join('')
  t.check('the pre-cycle 120-col card is complete', key(textOf(first)) === '11111', key(textOf(first)))
  t.check('the note survived the whole cycle', textOf(back).includes('keep flat'))
  const cardTop = findRows(back.rows, 'Which config shape')[0] ?? 0
  const pointer = findRows(back.rows, '❯').filter(r => r >= cardTop)
  const flat = findRows(back.rows, 'Flat').filter(r => r >= cardTop)
  t.check('the focused option survived the whole cycle', pointer.some(r => flat.includes(r)))
  t.check('the same information set as before the cycle', key(textOf(back)) === key(textOf(first)), key(textOf(back)))
} finally {
  cycle.cleanup()
}

// ── the height budget: question AND controls survive a short terminal ──────
const LONG_PREVIEW = Array.from({ length: 48 }, (_, i) => `line ${String(i + 1).padStart(2, '0')} — body`).join('\n')
const short = await runArtifactArena({
  turns: [
    {
      kind: 'tool_use',
      name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Adopt the long migration script?',
            header: 'Migration',
            options: [
              { label: 'Adopt', description: 'Run as generated.', preview: LONG_PREVIEW },
              { label: 'Rewrite', description: 'Shorter by hand.' },
            ],
          },
        ],
      },
      id: 'auq_h',
      preText: 'One decision remains open.',
    },
  ],
  sends: ['8000:review the migration', '8800:\r'],
  seconds: 15,
  cols: 120,
  rows: 30,
  probe: false,
  keep: true,
})
try {
  void firstOutputTs(short)
  const s = grabScreens(short, 120, 30, [S(13_000)])[0]!
  const text = s.rows.join('\n')
  t.section('§height — question and controls survive; the preview is bounded')
  t.check('the QUESTION stayed on screen (law B2 very-short)', text.includes('Adopt the long migration script?'))
  t.check('the controls stayed on screen', text.includes('Chat about this'))
  t.check('the truncation bar names the hidden lines', /\d+ lines hidden/.test(text))
  t.check('the tail line never paints', !text.includes('line 48'))
} finally {
  short.cleanup()
}

t.finish('prove-journey-width-matrix')
