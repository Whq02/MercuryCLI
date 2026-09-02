#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-journey-discuss-return.ts — in the BUILT
//  binary: the operator notes a question, opens a discussion, the model
//  returns with the SAME question reworded — and the note is still there.
//
//  Drives the SHIPPED dist/mercury.mjs in the hermetic PTY arena against the
//  deterministic fixture API (two scripted AUQ rounds sharing declared ids).
//  Asserts from the real screens AND the real wire:
//    §1  round 1 paints the preview card; the note lands ('n' → text → Esc);
//    §2  "Chat about this" crosses as the TYPED discussion outcome — the
//        tool_result names DISCUSS and promises the preserved session;
//    §3  round 2 paints the REWORDED question with the operator's note
//        intact — identity continuity visible in the product, not a prover.
//
//  Requires the prebuilt dist (the pooled gate prebuilds it in Phase 0).
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import {
  firstOutputTs,
  grabScreens,
  requireDist,
  runArtifactArena,
} from '../streaming/artifactArena.ts'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { checker } from '../engine-durability/harness.ts'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

const t = checker()
requireDist()

const NOTE = 'check the ops budget'
const Q = (text: string) => ({
  id: 'iq_engine',
  decisionId: 'id_engine',
  question: text,
  header: 'Cache',
  options: [
    { id: 'io_layered', label: 'Layered', description: 'Defaults merged per root.', preview: '### Layered\n\n```ts\nmerge(defaults, local)\n```' },
    { id: 'io_flat', label: 'Flat', description: 'One frozen constant.', preview: '### Flat\n\n```ts\nObject.freeze({ ttl: 300 })\n```' },
  ],
  multiSelect: false,
})

const TURNS: ScriptedTurn[] = [
  { kind: 'tool_use', name: 'AskUserQuestion', input: { questions: [Q('Which config shape should ship?')] }, id: 'auq_r1', preText: 'Two shapes are viable.' },
  { kind: 'tool_use', name: 'AskUserQuestion', input: { questions: [Q('Which config shape should ship, given the ops budget?')] }, id: 'auq_r2', preText: 'Good question — the budget favors fewer moving parts. Back to the decision:' },
  { kind: 'text', text: 'Understood.' },
]

const run = await runArtifactArena({
  turns: TURNS,
  // prompt · submit · note ('n' + text + Esc) · ↓↓ to footer · Enter (discuss)
  sends: [
    '8000:design the config layer',
    '8800:\r',
    '13000:n',
    `13600:${NOTE}`,
    '15000:\x1b',
    '15600:\x1b[B',
    '16000:\x1b[B',
    '16400:\r',
  ],
  seconds: 22,
  cols: 120,
  rows: 44,
  probe: false,
  keep: true,
})

try {
  void firstOutputTs(run)
  const screens = grabScreens(run, 120, 44, [S(12_500), S(14_500), S(19_500), -1])
  const text = (i: number): string => screens[i]!.rows.join('\n')

  t.section('§1 — round 1: the card and the note')
  t.check('the round-1 question painted', text(0).includes('Which config shape should ship?'))
  t.check('the note landed on screen', text(1).includes(NOTE))

  t.section('§2 — the typed discussion outcome on the wire')
  {
    const bodies = run.fixture
      .messageRequests()
      .map(r => JSON.stringify(r.body))
    const withResult = bodies.filter(b => b.includes('tool_result'))
    t.check('a tool_result crossed after the discuss', withResult.length >= 1)
    const last = withResult.at(-1) ?? ''
    t.check('the result NAMES the discussion', last.includes('DISCUSS'))
    t.check('the result promises the preserved session', last.includes('resume at this question'))
    t.check('the result is not a fake submission', !last.includes('User has answered your questions'))
  }

  t.section('§3 — the return: reworded question, same identity, note intact')
  {
    const finalText = text(2).includes('ops budget') ? text(2) : text(3)
    t.check('the REWORDED question painted', finalText.includes('given the ops budget'))
    t.check('the operator note survived the round-trip IN THE PRODUCT', finalText.includes(NOTE))
  }
} finally {
  run.cleanup()
}

t.finish('prove-journey-discuss-return')
