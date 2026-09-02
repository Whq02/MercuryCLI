#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-journey-context-paste.ts — in the
//  BUILT binary: a large paste into the interview notes becomes a STABLE
//  context reference — the body is stored once, the note carries a short
//  citation, the model receives the body exactly once at the boundary tagged
//  with its refId and decision, and the durable authority + decision record
//  carry the reference.
//
//  One journey through the SHIPPED dist/mercury.mjs: open notes on a preview
//  card, bracketed-paste a 60-line body, leave notes, select the focused
//  option (single question ⇒ auto-submit). Asserts from the dense screen
//  timeline, the real wire, the durable session log, and the persisted
//  decision record.
//
//  Requires the prebuilt dist (the pooled gate prebuilds it in Phase 0).
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
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

const BODY = Array.from({ length: 60 }, (_, i) => `pasted line ${i + 1} — context body`).join('\n')

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
    id: 'auq_ctx',
    preText: 'One decision remains open.',
  },
  { kind: 'text', text: 'Understood — proceeding with the decision.' },
]

const run = await runArtifactArena({
  turns: TURNS,
  sends: [
    '8000:design the config layer',
    '8800:\r',
    '12500:n', // open notes
    `13300:\x1b[200~${BODY}\x1b[201~`, // one bracketed paste, one write
    '14800:\x1b', // leave notes
    '15600:\r', // select 'Layered' → single question ⇒ submit
  ],
  seconds: 22,
  cols: 120,
  rows: 44,
  probe: false,
  keep: true,
})

try {
  const base = firstOutputTs(run)
  const sends = run.sendLog.map(s => ({ at: s.sent - base, data: Buffer.from(s.b64, 'base64').toString() }))
  const escAt = sends.find(s => s.data === '\x1b')?.at ?? -1
  const enterAt = sends.filter(s => s.data === '\r').at(-1)?.at ?? -1
  const offsets: number[] = []
  for (let ms = S(12_000); ms <= S(21_000); ms += S(300)) offsets.push(ms)
  const timeline = grabScreens(run, 120, 44, offsets)
  const textOf = (s: GrabbedScreen): string => s.rows.join('\n')
  const inWindow = (from: number, to: number): GrabbedScreen[] =>
    timeline.filter(s => s.atMs >= from && s.atMs <= to)

  t.section('§1 — the note shows a citation, never the body')
  const afterPaste = inWindow(escAt + 200, enterAt - 50)
  t.check('the citation painted on the notes row', afterPaste.some(s => /\[Pasted context: \d+ lines\]/.test(textOf(s))))
  t.check(
    'the raw body never painted inline',
    timeline.every(s => !textOf(s).includes('pasted line 3 — context body')),
  )

  t.section('§2 — the body crosses the boundary ONCE, tagged ref + decision')
  const bodies = run.fixture.messageRequests().map(r => JSON.stringify(r.body))
  const result = bodies.filter(b => b.includes('tool_result')).at(-1) ?? ''
  t.check('a tool_result crossed after the submit', result.length > 0)
  t.check('the context block names its ref', result.includes('interview-context ref=') && result.includes('paste:'))
  t.check('and carries the full body', result.includes('pasted line 60'))
  t.check('the note annotation carries the citation', /\[Pasted context: \d+ lines\]/.test(result))

  t.section('§3 — the durable authority and decision record carry the reference')
  const dir = join(run.paths.home, '.claude', 'interview')
  const files = readdirSync(dir)
  const logFile = files.find(f => /^[0-9a-f]{16}\.json$/.test(f))
  const recFile = files.find(f => f.endsWith('-record.json'))
  t.check('the durable session log exists', logFile !== undefined, files.join(','))
  t.check('the decision record persisted at submit', recFile !== undefined, files.join(','))
  if (logFile && recFile) {
    const log = JSON.parse(readFileSync(join(dir, logFile), 'utf8')) as {
      sessions: Record<string, { events: { kind: string; ref?: { refId: string; kind: string }; questionId?: string }[] }>
    }
    const events = Object.values(log.sessions)[0]?.events ?? []
    const attached = events.find(e => e.kind === 'context-attached')
    t.check('the typed context-attached event is in the log', attached !== undefined)
    t.check('as a large-paste reference', attached?.ref?.kind === 'large-paste' && attached.ref.refId.startsWith('paste:'))
    t.check('scoped to the asked decision', typeof attached?.questionId === 'string' && attached.questionId.length > 0)
    const rec = JSON.parse(readFileSync(join(dir, recFile), 'utf8')) as {
      decisions: { contextRefIds: string[] }[]
    }
    t.check(
      'the decision record joins the reference by id',
      rec.decisions.some(d => d.contextRefIds.some(r => r.startsWith('paste:'))),
    )
  }
} finally {
  run.cleanup()
}

t.finish('prove-journey-context-paste')
