#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-journey-input-graph.ts — in the BUILT
//  binary: exactly ONE action fires per input on the interview card.
//
//  The regression class this pins (GLOBAL-BINDING-OVER-FOCUSED-DIALOG in
//  the recorded class): chat:cancel staying active over the focused
//  interview card swallowed Escape in the useInput phase and aborted EVERY
//  pending ask — the card's own handler never saw the press. The card now
//  owns Escape while focused (the elicitation guard class).
//
//  One journey through the SHIPPED dist/mercury.mjs, press by press, read
//  from a DENSE screen timeline, the real wire, and the DURABLE session log:
//    §1  digit focuses WITHOUT selecting; ↓ past the last option lands the
//        footer; ↑ returns — one visible consequence per press;
//    §2  'n' opens notes; the FIRST Esc leaves notes and NOTHING else;
//    §3  Esc at the card root is the interview's OWN typed cancel: the card
//        closes, the turn ends with NO extra model round, the composer
//        returns, and the durable session log records the cancelled outcome
//        WITH the drafted note preserved.
//
//  Requires the prebuilt dist (the pooled gate prebuilds it in Phase 0).
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  findRows,
  grabScreens,
  requireDist,
  runArtifactArena,
  sendStamp,
  type GrabbedScreen,
} from '../streaming/artifactArena.ts'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { checker } from '../engine-durability/harness.ts'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

const t = checker()
requireDist()

const TURNS: ScriptedTurn[] = [
  {
    kind: 'tool_use',
    name: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Which config shape should ship?',
          header: 'Config',
          options: [
            { label: 'Layered', description: 'Defaults merged per root.', preview: '### Layered\n\n```ts\nmerge(defaults, local)\n```' },
            { label: 'Flat', description: 'One frozen constant.', preview: '### Flat\n\n```ts\nObject.freeze({ ttl: 300 })\n```' },
          ],
        },
      ],
    },
    id: 'auq_graph',
    preText: 'One decision remains open.',
  },
  { kind: 'text', text: 'Understood — stopping here as asked.' },
]

const run = await runArtifactArena({
  turns: TURNS,
  sends: [
    '8000:design the config layer',
    '8800:\r',
    '12500:2', // digit → focus option 2, navigate-only
    '13400:\x1b[B', // ↓ from the last option → footer
    '14400:\x1b[A', // ↑ → back to the options
    '15400:n', // open notes
    '16000:budget matters', // type a note
    '17000:\x1b', // FIRST Esc: leaves notes, nothing else
    '18400:\x1b', // Esc at the card root: the typed cancel
  ],
  seconds: 23,
  cols: 120,
  rows: 44,
  probe: false,
  keep: true,
})

try {
  // Screen grabs are stamped with authored offsets; a send's moment in that
  // same base is sendStamp (the anchor's re-base cancels on both sides), so
  // boot jitter can never slide an assertion across a press.
  const sends = run.sendLog.map(s => ({ at: sendStamp(run, s), data: Buffer.from(s.b64, 'base64').toString() }))
  const sendAt = (data: string, nth = 0): number =>
    sends.filter(s => s.data === data)[nth]?.at ?? -1
  const offsets: number[] = []
  for (let ms = S(11_000); ms <= S(22_000); ms += S(300)) offsets.push(ms)
  const timeline = grabScreens(run, 120, 44, offsets)
  const textOf = (s: GrabbedScreen): string => s.rows.join('\n')
  const inWindow = (from: number, to: number): GrabbedScreen[] =>
    timeline.filter(s => s.atMs >= from && s.atMs <= to)
  const pointerOn = (s: GrabbedScreen, needle: string): boolean => {
    const cardTop = findRows(s.rows, 'Which config shape should ship?')[0] ?? 0
    const p = findRows(s.rows, '❯').filter(r => r >= cardTop)
    const n = findRows(s.rows, needle).filter(r => r >= cardTop)
    return p.some(r => n.includes(r))
  }

  const digitAt = sendAt('2')
  const downAt = sendAt('\x1b[B')
  const upAt = sendAt('\x1b[A')
  const nAt = sendAt('n')
  const noteAt = sendAt('budget matters')
  const esc1At = sendAt('\x1b', 0)
  const esc2At = sendAt('\x1b', 1)

  t.section('§1 — one visible consequence per navigation press')
  t.check(
    'digit 2 focused the second option',
    inWindow(digitAt + 100, downAt - 50).some(s => pointerOn(s, 'Flat')),
  )
  t.check(
    '…without selecting it (no tick anywhere on the card)',
    inWindow(digitAt + 100, downAt - 50).every(s => !s.rows.some(r => r.includes('Flat') && r.includes('✔'))),
  )
  t.check(
    '↓ from the last option landed the footer',
    inWindow(downAt + 100, upAt - 50).some(s => pointerOn(s, 'Chat about this')),
  )
  t.check(
    '↑ returned to the options',
    inWindow(upAt + 100, nAt - 50).some(s => pointerOn(s, 'Flat')),
  )

  t.section('§2 — the first Esc leaves notes and does nothing else')
  t.check(
    'n opened the notes input (the typed note painted)',
    inWindow(noteAt + 200, esc1At - 50).some(s => textOf(s).includes('budget matters')),
  )
  const afterEsc = inWindow(esc1At + 250, esc2At - 100)
  t.check(
    'the card SURVIVED the first Esc',
    afterEsc.length > 0 && afterEsc.every(s => textOf(s).includes('Which config shape should ship?')),
    `${afterEsc.length} frame(s) in [${esc1At + 250},${esc2At - 100}]`,
  )
  t.check('the note persisted after the exit', afterEsc.some(s => textOf(s).includes('budget matters')))

  t.section('§3 — Esc at the root is the interview cancel: turn ends, draft survives durably')
  const final = timeline.at(-1)!
  t.check('the card closed (its help line is gone)', !textOf(final).includes('Enter to select'))
  // The submit also fires the session-title side call on the small model;
  // the law counts the MAIN model's rounds.
  const mainRounds = run.fixture
    .messageRequests()
    .filter(r => String((r.body as { model?: string }).model ?? '').includes('opus'))
  // Each request's shape rides the detail (the last message's role and its
  // block types), so a surplus round names itself: a tool_result round
  // is the turn continuing; a bare user turn is a side call on this model.
  const roundShape = (r: { body: unknown }): string => {
    const last = (r.body as { messages?: { role?: string; content?: unknown }[] }).messages?.at(-1)
    const kinds = Array.isArray(last?.content)
      ? last.content.map(c => (c as { type?: string }).type ?? '?').join('+')
      : typeof last?.content
    return `${last?.role ?? '?'}:${kinds}`
  }
  t.check(
    'no extra model round fired — the rejection ends the turn',
    mainRounds.length === 1,
    `${mainRounds.length} main-model request(s): ${mainRounds.map(roundShape).join(' · ')}`,
  )
  t.check('the composer returned to the operator', textOf(final).includes('? for shortcuts'))
  {
    // The durable authority recorded the TYPED outcome — and kept the draft.
    const dir = join(run.paths.home, '.claude', 'interview')
    const files = readdirSync(dir).filter(f => f.endsWith('.json'))
    t.check('the durable session log exists', files.length === 1, files.join(','))
    const log = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')) as {
      sessions: Record<string, { events: { kind: string; note?: string; preserveDraft?: boolean }[] }>
    }
    const events = Object.values(log.sessions)[0]?.events ?? []
    const cancelled = events.find(e => e.kind === 'cancelled')
    t.check('the cancelled outcome is typed in the log', cancelled !== undefined)
    t.check('…with the draft-preserving contract', cancelled?.preserveDraft === true)
    t.check(
      'the drafted note SURVIVED the cancel in the durable authority',
      events.some(e => e.kind === 'note-set' && (e.note ?? '').includes('budget matters')),
    )
  }
} finally {
  run.cleanup()
}

// ── the question axis: Tab/Shift-Tab move EXACTLY one question ──────────────
const TWOQ: ScriptedTurn[] = [
  {
    kind: 'tool_use',
    name: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Which config shape should ship?',
          header: 'Config',
          options: [
            { label: 'Layered', description: 'Merged.', preview: '### L' },
            { label: 'Flat', description: 'Frozen.', preview: '### F' },
          ],
        },
        {
          question: 'Which eviction policy fits?',
          header: 'Eviction',
          options: [
            { label: 'LRU', description: 'Recency.' },
            { label: 'LFU', description: 'Frequency.' },
          ],
        },
      ],
    },
    id: 'auq_tabs',
    preText: 'Two decisions remain open.',
  },
]

const run2 = await runArtifactArena({
  turns: TWOQ,
  sends: [
    '8000:design the cache',
    '8800:\r',
    '12500:\x1b[B', // focus 'Flat' on q1 (the marker Shift-Tab must restore)
    '13300:\t', // Tab → q2, exactly one step
    '14300:\x1b[Z', // Shift-Tab → back to q1
  ],
  seconds: 18,
  cols: 120,
  rows: 44,
  probe: false,
  keep: true,
})

try {
  const sends2 = run2.sendLog.map(s => ({ at: sendStamp(run2, s), data: Buffer.from(s.b64, 'base64').toString() }))
  const tabAt = sends2.find(s => s.data === '\t')?.at ?? -1
  const shiftTabAt = sends2.find(s => s.data === '\x1b[Z')?.at ?? -1
  const offsets2: number[] = []
  for (let ms = S(12_000); ms <= S(17_000); ms += S(300)) offsets2.push(ms)
  const tl = grabScreens(run2, 120, 44, offsets2)
  const textOf2 = (s: GrabbedScreen): string => s.rows.join('\n')
  const win = (from: number, to: number): GrabbedScreen[] => tl.filter(s => s.atMs >= from && s.atMs <= to)

  t.section('§4 — Tab and Shift-Tab move exactly one question')
  t.check(
    'Tab advanced to q2 (and only q2)',
    win(tabAt + 150, shiftTabAt - 50).some(
      s => textOf2(s).includes('Which eviction policy fits?') && !textOf2(s).includes('Review your answers'),
    ),
  )
  t.check(
    'Shift-Tab returned to q1',
    win(shiftTabAt + 150, 17_000).some(s => textOf2(s).includes('Which config shape should ship?')),
  )
  t.check(
    // Option focus is transient presentation BY CONTRACT: a revisited
    // question derives its pointer from the SELECTED option, else the
    // first (the session authority stores question-level focus; drafts and
    // commits — not hover — are the durable meaning).
    'q1 reopens on its derived focus (selected ?? first)',
    win(shiftTabAt + 150, 17_000).some(s => {
      const top = findRows(s.rows, 'Which config shape')[0] ?? 0
      const p = findRows(s.rows, '❯').filter(r => r >= top)
      const first = findRows(s.rows, 'Layered').filter(r => r >= top)
      return p.some(r => first.includes(r))
    }),
  )
} finally {
  run2.cleanup()
}

t.finish('prove-journey-input-graph')
