#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-journey-answer-modes.ts — + in the
//  BUILT binary: every answer mode works end to end, and review supports
//  direct edit with the return position restored.
//
//  One journey through the SHIPPED dist/mercury.mjs (hermetic PTY arena +
//  deterministic fixture API): four questions covering single-select,
//  multi-select toggling, the Other free-text route, and a preview card —
//  then the review, a direct edit of question 1 FROM review, the restored
//  review position, and the submit. Asserts from a DENSE screen timeline
//  (first-seen ordering, never a single fragile offset) AND the real wire.
//
//    §1  the modes advance in presentation order, one commit each;
//    §2  review paints every decision with its answer (free text included);
//    §3  direct edit: the review row jumps to the question, the revision
//        lands, and the cursor returns to the SAME review row;
//    §4  the wire result carries the REVISED answer, both multi-select
//        labels, and the free text.
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

const Q1 = 'Which storage engine should the cache use?'
const Q2 = 'Which features should the cache expose?'
const Q3 = 'What should the cache key prefix be?'
const Q4 = 'Which config shape should ship?'

const TURNS: ScriptedTurn[] = [
  {
    kind: 'tool_use',
    name: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: Q1,
          header: 'Cache',
          options: [
            { label: 'Redis', description: 'Shared network cache.' },
            { label: 'In-memory', description: 'Process-local.' },
            { label: 'File-based', description: 'Durable on one host.' },
          ],
        },
        {
          question: Q2,
          header: 'Features',
          multiSelect: true,
          options: [
            { label: 'TTL expiry', description: 'Time-based invalidation.' },
            { label: 'Manual flush', description: 'An operator command.' },
            { label: 'Stats endpoint', description: 'Hit/miss counters.' },
          ],
        },
        {
          question: Q3,
          header: 'Naming',
          options: [
            { label: 'app_', description: 'The generic prefix.' },
            { label: 'svc_', description: 'The service prefix.' },
          ],
        },
        {
          question: Q4,
          header: 'Config',
          options: [
            { label: 'Layered', description: 'Defaults merged per root.', preview: '### Layered\n\n```ts\nmerge(defaults, local)\n```' },
            { label: 'Flat', description: 'One frozen constant.', preview: '### Flat\n\n```ts\nObject.freeze({ ttl: 300 })\n```' },
          ],
        },
      ],
    },
    id: 'auq_modes',
    preText: 'Four decisions remain open.',
  },
  { kind: 'text', text: 'Understood — proceeding with the decisions.' },
]

const run = await runArtifactArena({
  turns: TURNS,
  sends: [
    '8000:design the cache layer',
    '8800:\r',
    // q1 single-select: ↓ + Enter answers 'In-memory' and advances.
    '12500:\x1b[B',
    '12900:\r',
    // q2 multi-select: toggle rows 1 and 2, Tab advances.
    '13400: ',
    '13800:\x1b[B',
    '14200: ',
    '14700:\t',
    // q3 Other free text: ↓↓ to the Other row, type, Enter commits.
    '15300:\x1b[B',
    '15600:\x1b[B',
    '16100:orchard_cache',
    '16900:\r',
    // q4 preview card: Enter selects the focused 'Layered' → review.
    '17400:\r',
    // review: Enter on the first decision row jumps to q1.
    '18500:\r',
    // revise q1 to 'File-based'; commit returns TO review.
    '19000:\x1b[B',
    '19300:\r',
    // from the restored q1 row: ↓×4 to 'Submit answers', Enter.
    '19900:\x1b[B',
    '20200:\x1b[B',
    '20500:\x1b[B',
    '20800:\x1b[B',
    '21200:\r',
  ],
  seconds: 26,
  cols: 120,
  rows: 44,
  probe: false,
  keep: true,
})

try {
  void firstOutputTs(run)
  // The dense timeline: a screen every 300 ms across the whole interaction.
  const offsets: number[] = []
  for (let ms = S(11_000); ms <= S(25_000); ms += S(300)) offsets.push(ms)
  const timeline = grabScreens(run, 120, 44, offsets)
  const textOf = (s: GrabbedScreen): string => s.rows.join('\n')
  const firstSeen = (needle: string): number =>
    timeline.find(s => textOf(s).includes(needle))?.atMs ?? -1
  const screensWith = (...needles: string[]): GrabbedScreen[] =>
    timeline.filter(s => {
      const x = textOf(s)
      return needles.every(n => x.includes(n))
    })

  t.section('§1 — the modes advance in presentation order, one commit each')
  // LIVE sightings only: the review recap re-prints
  // every question, so a grab-starved run that missed a LIVE paint would
  // alias its first sighting into the recap and poison the ORDER legs (the
  // recorded run: q1 first-seen @16700 — the recap — AFTER q2 @11000). A
  // missed live paint must fail its own PAINTED leg typed instead.
  const tReview = firstSeen('Review your answers')
  const firstSeenLive = (needle: string): number =>
    timeline.find(s => (tReview < 0 || s.atMs < tReview) && textOf(s).includes(needle))?.atMs ?? -1
  const t1 = firstSeenLive(Q1)
  const t2 = firstSeenLive(Q2)
  const t3 = firstSeenLive(Q3)
  const t4 = firstSeenLive(Q4)
  t.check('q1 (single-select) painted', t1 >= 0, `@${t1}`)
  t.check('q2 (multi-select) followed the q1 commit', t2 > t1, `@${t2}`)
  t.check('q3 (Other route) followed the toggles + Tab', t3 > t2, `@${t3}`)
  t.check('q4 (preview) followed the free-text commit', t4 > t3, `@${t4}`)
  t.check('review followed the q4 commit', tReview > t4, `@${tReview}`)

  t.section('§2 — review paints every decision with its answer')
  const firstReview = screensWith('Review your answers')[0]
  t.check('the review view painted', firstReview !== undefined)
  const reviewText = firstReview ? textOf(firstReview) : ''
  t.check('the free-text answer is on its review row', reviewText.includes('orchard_cache'))
  t.check(
    'the multi-select answer names both labels',
    reviewText.includes('TTL expiry') && reviewText.includes('Manual flush'),
  )

  t.section('§3 — direct edit from review, return position restored')
  const tBack = timeline.find(s => s.atMs > tReview && textOf(s).includes(Q1) && !textOf(s).includes('Review your answers'))
  t.check('selecting the q1 row jumped straight to q1', tBack !== undefined, `@${tBack?.atMs}`)
  const returned = screensWith('Review your answers', 'File-based').find(s => s.atMs > (tBack?.atMs ?? Infinity))
  t.check('the revision landed and review repainted', returned !== undefined, `@${returned?.atMs}`)
  if (returned) {
    // Pointer search INSIDE the card: rows at/after the review title (the
    // composer prompt glyph also paints '❯' in history rows above it).
    const titleRow = findRows(returned.rows, 'Review your answers')[0] ?? 0
    const pointerRows = findRows(returned.rows, '❯').filter(r => r >= titleRow)
    const q1Rows = findRows(returned.rows, '✔ Cache').filter(r => r >= titleRow)
    t.check(
      'the review cursor returned to the SAME row (q1)',
      pointerRows.some(r => q1Rows.includes(r)),
      `pointer@${pointerRows.join(',')} q1row@${q1Rows.join(',')}`,
    )
  }

  t.section('§4 — the wire result carries the final decisions')
  const bodies = run.fixture.messageRequests().map(r => JSON.stringify(r.body))
  const result = bodies.filter(b => b.includes('tool_result')).at(-1) ?? ''
  t.check('a tool_result crossed after submit', result.length > 0)
  t.check('it is the answered shape', result.includes('User has answered your questions'))
  t.check('q1 carries the REVISED answer', result.includes('File-based'))
  t.check('the multi-select carries both labels', result.includes('TTL expiry') && result.includes('Manual flush'))
  t.check('the free text survived', result.includes('orchard_cache'))
  t.check('the final turn painted (the session continued)', firstSeen('Understood') > 0)
} finally {
  run.cleanup()
}

t.finish('prove-journey-answer-modes')
