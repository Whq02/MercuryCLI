#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-journey-early-finish.ts — the early-finish
//  leg in the BUILT binary: the operator deliberately finishes the plan
//  interview with a decision still open, and the finish crosses as its OWN
//  typed outcome (never a disguised rejection).
//
//  Plan mode (shift+tab ×2 pre-prompt), one unanswered question. The footer
//  is reached by keyboard, the pointer is ASSERTED on each footer row before
//  Enter (so a mis-navigation reds the right check), and the wire result is
//  the self-naming finish shape riding onAllow — the turn CONTINUES.
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

const Q = 'Which storage engine should the cache use?'

const TURNS: ScriptedTurn[] = [
  {
    kind: 'tool_use',
    name: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: Q,
          header: 'Cache',
          options: [
            { label: 'Redis', description: 'Shared network cache.' },
            { label: 'In-memory', description: 'Process-local.' },
            { label: 'File-based', description: 'Durable on one host.' },
          ],
        },
      ],
    },
    id: 'auq_finish',
    preText: 'One decision remains open.',
  },
  { kind: 'text', text: 'Understood — proceeding without further questions.' },
]

const run = await runArtifactArena({
  turns: TURNS,
  sends: [
    '7000:\x1b[Z', // shift+tab ×2 → plan mode (the j10 baseline convention)
    '7400:\x1b[Z',
    '8000:design the cache layer',
    '8800:\r',
    // ↓ walks the rows; the pointer is asserted from the timeline before
    // each activation, so the walk self-verifies.
    '12500:\x1b[B',
    '13000:\x1b[B',
    '13500:\x1b[B',
    '14000:\x1b[B', // expect: footer row 0 — 'Chat about this'
    '14800:\x1b[B', // expect: footer row 1 — 'Skip interview and plan immediately'
    '15600:\r',
  ],
  seconds: 21,
  cols: 120,
  rows: 40,
  probe: false,
  keep: true,
})

try {
  // Windows anchor to each send's moment in the grab's own stamp base
  // (sendStamp): the anchor's re-base cancels on both sides, so boot
  // jitter can never slide an assertion across a press.
  const sends = run.sendLog.map(s => ({ at: sendStamp(run, s), data: Buffer.from(s.b64, 'base64').toString() }))
  const downs = sends.filter(s => s.data === '\x1b[B').map(s => s.at)
  const enterAt = sends.filter(s => s.data === '\r').at(-1)?.at ?? -1
  const offsets: number[] = []
  for (let ms = S(12_000); ms <= S(20_000); ms += S(300)) offsets.push(ms)
  const timeline = grabScreens(run, 120, 40, offsets)
  const textOf = (s: GrabbedScreen): string => s.rows.join('\n')
  const inWindow = (from: number, to: number): GrabbedScreen[] =>
    timeline.filter(s => s.atMs >= from && s.atMs <= to)
  const pointerOn = (s: GrabbedScreen, needle: string): boolean => {
    const cardTop = findRows(s.rows, Q)[0] ?? 0
    const p = findRows(s.rows, '❯').filter(r => r >= cardTop)
    const n = findRows(s.rows, needle).filter(r => r >= cardTop)
    return p.some(r => n.includes(r))
  }

  t.section('§1 — the footer is reached by keyboard, row by row')
  t.check('the card painted with the question open', timeline.some(s => textOf(s).includes(Q)))
  t.check(
    'the walk reached the discussion footer row',
    inWindow(downs[3]! + 100, downs[4]! - 50).some(s => pointerOn(s, 'Chat about this')),
  )
  t.check(
    'one more ↓ reached the finish row (plan mode only)',
    inWindow(downs[4]! + 100, enterAt - 50).some(s => pointerOn(s, 'Skip interview and plan immediately')),
  )

  t.section('§2 — the finish crosses as its own typed outcome and the turn continues')
  const bodies = run.fixture.messageRequests().map(r => JSON.stringify(r.body))
  const result = bodies.filter(b => b.includes('tool_result')).at(-1) ?? ''
  t.check('a tool_result crossed after the finish', result.length > 0)
  t.check('it NAMES the early finish', result.includes('finished the interview early'))
  t.check('and instructs the model to stop asking', result.includes('Stop asking further questions'))
  t.check('it is not a disguised rejection', !result.includes("doesn't want to proceed"))
  t.check(
    'the turn CONTINUED to the next model text',
    timeline.some(s => textOf(s).includes('proceeding without further questions')),
  )

  t.section('§3 — the durable authority recorded the typed finish')
  const dir = join(run.paths.home, '.claude', 'interview')
  const files = readdirSync(dir).filter(f => f.endsWith('.json'))
  t.check('the durable session log exists', files.length === 1, files.join(','))
  const log = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')) as {
    sessions: Record<string, { events: { kind: string }[] }>
  }
  const events = Object.values(log.sessions)[0]?.events ?? []
  t.check(
    'the finish-requested outcome is typed in the log',
    events.some(e => e.kind === 'finish-requested'),
  )
} finally {
  run.cleanup()
}

t.finish('prove-journey-early-finish')
