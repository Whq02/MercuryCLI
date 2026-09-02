#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  firstOutputTs,
  grabScreens,
  requireDist,
  runArtifactArena,
  type ArenaRun,
} from '../streaming/artifactArena.ts'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'

const OUT = join(import.meta.dir, 'baselines')
mkdirSync(OUT, { recursive: true })

const only = (() => {
  const i = process.argv.indexOf('--only')
  return i >= 0 ? process.argv[i + 1] : null
})()


const Q = (over: Record<string, unknown> = {}) => ({
  question: 'Which storage engine should the cache use?',
  header: 'Cache',
  options: [
    { label: 'Redis', description: 'A shared network cache; adds an infra dependency.' },
    { label: 'In-memory', description: 'Process-local; zero infra but not shared.' },
    { label: 'File-based', description: 'Durable and shared on one host; slowest.' },
  ],
  ...over,
})

const MD_PREVIEW = [
  '### Option A — layered config',
  '',
  '```ts',
  'export function loadConfig(root: string): Config {',
  '  return merge(defaults, readFile(root))',
  '}',
  '```',
  '',
  '| key | default |',
  '|-----|---------|',
  '| ttl | 300s    |',
].join('\n')

const CODE_PREVIEW = [
  '### Option B — flat config',
  '',
  '```ts',
  'export const CONFIG: Config = Object.freeze({ ttl: 300 })',
  '```',
].join('\n')

const LONG_PREVIEW = Array.from({ length: 48 }, (_, i) => `line ${String(i + 1).padStart(2, '0')} — the preview body continues`).join('\n')

const AUQ = (questions: unknown[], id = 'auq_1'): ScriptedTurn => ({
  kind: 'tool_use',
  name: 'AskUserQuestion',
  input: { questions },
  id,
  preText: 'Let me confirm the open decisions before proceeding.',
})

const DONE: ScriptedTurn = { kind: 'text', text: 'Understood — proceeding with the decisions.' }

const PROMPT = '8000:design the cache layer'
const SUBMIT = '8800:\r'

interface Journey {
  name: string
  note: string
  turns: ScriptedTurn[]
  sends: string[]
  resizes?: string[]
  cols: number
  rows: number
  seconds: number
  screens: number[]
}

const JOURNEYS: Journey[] = [
  {
    name: 'j01-single-choice-120',
    note: 'contract journey 1 — one simple single-choice question, standard width',
    turns: [AUQ([Q()])],
    sends: [PROMPT, SUBMIT],
    cols: 120, rows: 40, seconds: 15,
    screens: [12_000, -1],
  },
  {
    name: 'j01n-single-choice-44',
    note: 'contract journey 12 (narrow leg) — the same card at 44 columns',
    turns: [AUQ([Q()])],
    sends: [PROMPT, SUBMIT],
    cols: 44, rows: 40, seconds: 15,
    screens: [12_000, -1],
  },
  {
    name: 'j02-four-questions-nav',
    note: 'contract journey 2 — four questions, unanswered navigation into review',
    turns: [
      AUQ([
        Q(),
        Q({ question: 'Which eviction policy fits the workload?', header: 'Eviction', options: [
          { label: 'LRU', description: 'Recency-based; the common default.' },
          { label: 'LFU', description: 'Frequency-based; resists scan pollution.' },
        ] }),
        Q({ question: 'Where should cache metrics land?', header: 'Metrics', options: [
          { label: 'StatsD', description: 'Existing pipeline; UDP fire-and-forget.' },
          { label: 'Log lines', description: 'No new infra; harder to graph.' },
        ] }),
        Q({ question: 'Should cache keys carry a version prefix?', header: 'Keys', options: [
          { label: 'Yes', description: 'Safe rolling deploys; longer keys.' },
          { label: 'No', description: 'Shorter keys; manual flush on schema change.' },
        ] }),
      ]),
    ],
    sends: [PROMPT, SUBMIT, '12500:\t', '13000:\t', '13500:\t', '14000:\t'],
    cols: 120, rows: 40, seconds: 17,
    screens: [12_200, 13_200, 14_500, -1],
  },
  {
    name: 'j03-multiselect-toggle',
    note: 'contract journey 3 — multi-select toggling two options (space), then the free-text Other row',
    turns: [AUQ([Q({
      question: 'Which features should the cache expose?',
      header: 'Features',
      multiSelect: true,
      options: [
        { label: 'TTL expiry', description: 'Time-based invalidation.' },
        { label: 'Manual flush', description: 'An operator command.' },
        { label: 'Stats endpoint', description: 'Hit/miss counters.' },
      ],
    })])],
    sends: [PROMPT, SUBMIT, '12500: ', '13000:\x1b[B', '13400: ', '13900:\x1b[B', '14300:\x1b[B'],
    cols: 120, rows: 40, seconds: 17,
    screens: [12_200, 13_600, 14_600, -1],
  },
  {
    name: 'j04-preview-compare',
    note: 'contract journey 4 — markdown/code preview comparison; focus moves between previewed options',
    turns: [AUQ([Q({
      question: 'Which config shape should ship?',
      header: 'Config',
      options: [
        { label: 'Layered', description: 'Defaults merged with per-root file.', preview: MD_PREVIEW },
        { label: 'Flat', description: 'One frozen constant.', preview: CODE_PREVIEW },
      ],
    })])],
    sends: [PROMPT, SUBMIT, '13000:\x1b[B', '13800:\x1b[A'],
    cols: 120, rows: 44, seconds: 17,
    screens: [12_500, 13_400, -1],
  },
  {
    name: 'j04n-preview-44',
    note: 'contract journey 12 (narrow leg) — the preview layout at 44 columns (raw 30-col left panel + 4 gap ⇒ 10 cells for preview)',
    turns: [AUQ([Q({
      question: 'Which config shape should ship?',
      header: 'Config',
      options: [
        { label: 'Layered', description: 'Defaults merged with per-root file.', preview: MD_PREVIEW },
        { label: 'Flat', description: 'One frozen constant.', preview: CODE_PREVIEW },
      ],
    })])],
    sends: [PROMPT, SUBMIT],
    cols: 44, rows: 44, seconds: 15,
    screens: [12_500, -1],
  },
  {
    name: 'j05-long-preview-truncation',
    note: 'contract journey 5 — a 48-line preview against the height budget; the truncation bar paints',
    turns: [AUQ([Q({
      question: 'Adopt the long migration script?',
      header: 'Migration',
      options: [
        { label: 'Adopt', description: 'Run it as generated.', preview: LONG_PREVIEW },
        { label: 'Rewrite', description: 'Hand-write a shorter one.' },
      ],
    })])],
    sends: [PROMPT, SUBMIT],
    cols: 120, rows: 30, seconds: 15,
    screens: [12_500, -1],
  },
  {
    name: 'j06-notes-internal',
    note: 'contract journey 6 (internal leg) — notes opened with n, typed, exited with Esc (external editor lands at Wave B)',
    turns: [AUQ([Q({
      question: 'Which config shape should ship?',
      header: 'Config',
      options: [
        { label: 'Layered', description: 'Defaults merged.', preview: MD_PREVIEW },
        { label: 'Flat', description: 'One constant.', preview: CODE_PREVIEW },
      ],
    })])],
    sends: [PROMPT, SUBMIT, '12800:n', '13300:prefer the layered shape', '14200:\x1b'],
    cols: 120, rows: 44, seconds: 17,
    screens: [13_800, 14_600, -1],
  },
  {
    name: 'j08-discuss-exit',
    note: 'contract journey 8 (baseline defect) — "Chat about this" ENDS the interview via onReject(prose); the wire body of request 2 records the flattened feedback shape',
    turns: [AUQ([Q()]), DONE],
    sends: [PROMPT, SUBMIT, '12500:\x1b[B', '12900:\x1b[B', '13300:\x1b[B', '13700:\r'],
    cols: 120, rows: 40, seconds: 18,
    screens: [13_500, 15_500, -1],
  },
  {
    name: 'j09-revise-after-later',
    note: 'contract journey 9 — answer q1..q2, tab BACK to q1, change the answer, tab forward; review shows the revision',
    turns: [
      AUQ([
        Q(),
        Q({ question: 'Which eviction policy fits the workload?', header: 'Eviction', options: [
          { label: 'LRU', description: 'Recency-based.' },
          { label: 'LFU', description: 'Frequency-based.' },
        ] }),
      ]),
      DONE,
    ],
    sends: [PROMPT, SUBMIT, '12500:\r', '13100:\r', '13700:\x1b[Z', '14100:\x1b[Z', '14600:\x1b[B', '15000:\r', '15600:\t'],
    cols: 120, rows: 40, seconds: 19,
    screens: [13_400, 14_300, 15_300, -1],
  },
  {
    name: 'j10-plan-footer',
    note: 'contract journey 10 — plan mode (shift+tab ×2 pre-prompt) surfaces "Skip interview and plan immediately"; activating it ENDS the interview via onReject(prose)',
    turns: [AUQ([Q()]), DONE],
    sends: ['7000:\x1b[Z', '7400:\x1b[Z', PROMPT, SUBMIT, '12500:\x1b[B', '12900:\x1b[B', '13300:\x1b[B', '13700:\x1b[B', '14100:\r'],
    cols: 120, rows: 40, seconds: 19,
    screens: [13_500, 15_800, -1],
  },
  {
    name: 'j11-cancel-esc',
    note: 'contract journey 11 (cancel leg) — Esc rejects the card; the resume-loss half is pinned by a Wave A reproducer instead of a capture',
    turns: [AUQ([Q()]), DONE],
    sends: [PROMPT, SUBMIT, '13000:\x1b'],
    cols: 120, rows: 40, seconds: 17,
    screens: [12_500, 14_500, -1],
  },
  {
    name: 'j12-resize-cycle',
    note: 'contract journey 12 — 120→80→44→120 with a preview card up; semantic state (focused option) must be inspectable at each width',
    turns: [AUQ([Q({
      question: 'Which config shape should ship?',
      header: 'Config',
      options: [
        { label: 'Layered', description: 'Defaults merged.', preview: MD_PREVIEW },
        { label: 'Flat', description: 'One constant.', preview: CODE_PREVIEW },
      ],
    })])],
    sends: [PROMPT, SUBMIT, '12500:\x1b[B'],
    resizes: ['13500:80:44', '15000:44:44', '16500:120:44'],
    cols: 120, rows: 44, seconds: 19,
    screens: [13_000, 14_200, 15_700, 17_200, -1],
  },
]


requireDist()

interface JourneyArtifact {
  journey: string
  note: string
  cols: number
  rows: number
  capturedAt: string
  screens: { atMs: number; rows: string[] }[]
  probe: { counters: Record<string, number>; frames: unknown } | null
  requests: unknown[]
  sends: { atMs: number; b64: string }[]
}

let failures = 0
for (const j of JOURNEYS) {
  if (only && j.name !== only) continue
  process.stdout.write(`── ${j.name} … `)
  let run: ArenaRun | null = null
  try {
    run = await runArtifactArena({
      turns: j.turns,
      sends: j.sends,
      resizes: j.resizes,
      seconds: j.seconds,
      cols: j.cols,
      rows: j.rows,
      probe: true,
      keep: true,
    })
    const base = firstOutputTs(run)
    void base
    const screens = grabScreens(run, j.cols, j.rows, j.screens)
    const artifact: JourneyArtifact = {
      journey: j.name,
      note: j.note,
      cols: j.cols,
      rows: j.rows,
      capturedAt: new Date().toISOString(),
      screens: screens.map(s => ({ atMs: s.atMs, rows: s.rows })),
      probe: run.probe
        ? { counters: run.probe.counters, frames: run.probe.frames }
        : null,
      requests: run.fixture.requests.map(r => ({
        path: r.path,
        model: (r.body as { model?: string })?.model,
        lastMessage: (() => {
          const msgs = (r.body as { messages?: unknown[] })?.messages
          return Array.isArray(msgs) ? msgs[msgs.length - 1] : undefined
        })(),
      })),
      sends: run.sendLog.map(s => ({ atMs: s.atMs, b64: s.b64 })),
    }
    writeFileSync(join(OUT, `${j.name}.json`), JSON.stringify(artifact, null, 1))
    const painted = screens.some(s => s.rows.some(r => r.includes('❯') || r.trim().length > 0))
    if (!painted) {
      failures++
      console.log('❌ captured but every screen is blank')
    } else {
      console.log(`✅ ${screens.length} screens, ${artifact.requests.length} wire requests`)
    }
  } catch (e) {
    failures++
    console.log(`❌ ${String(e).slice(0, 200)}`)
  } finally {
    run?.cleanup()
  }
}

console.log(failures === 0 ? '\n✅ baseline capture complete' : `\n❌ ${failures} journey(s) failed`)
process.exit(failures === 0 ? 0 : 1)
