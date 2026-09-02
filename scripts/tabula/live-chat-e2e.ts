#!/usr/bin/env bun
// ============================================================================
//  scripts/tabula/live-chat-e2e.ts — the BILLED live E2E for the MINERVA chat.
//  NOT gate-joined (real API usage — the helm-console live-e2e precedent).
//  Run explicitly:  ~/.bun/bin/bun run scripts/tabula/live-chat-e2e.ts
//
//  Drives the REAL binary in a PTY against a pid-scratch notepad (the
//  renderScenarios MERCURY_TABULA_DIR pin — the operator's real store is never
//  touched): seeds ONE open note, types `/minerva <message>` asking it to
//  capture a new intention and close the seeded one, ↵ — a REAL Sonnet-5
//  exchange plans ops through the validator into the journal.
//
//  The JOURNAL is the oracle (echo can't fake an appended event):
//   · ≥1 minerva-minted `add` landed (the message says "capture: …")
//   · meta.json carries lastChatAt (the exchange stamped)
//   · the reply line painted in the transcript ("Minerva:")
//  The seeded note's `done via:'minerva'` is model judgment — reported, not
//  asserted.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scenario, cleanupScenario } from '../ui/renderScenarios.ts'
import { gridToPng } from '../ui/gridToPng.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' LIVE MINERVA chat E2E — real binary · real ↵ · real Sonnet-5')
console.log('============================================================')

// 'tabula-empty' boots the resumed REPL with the scratch store pinned and
// seeds nothing — we seed our own single-note journal, then type /minerva.
const base = scenario('tabula-empty', 120, 44)
const slug = ROOT.replace(/[^a-zA-Z0-9]/g, '-')
const dir = join(process.env.MERCURY_TABULA_DIR!, slug)
mkdirSync(dir, { recursive: true })
writeFileSync(
  join(dir, 'journal.jsonl'),
  JSON.stringify({ t: '2026-07-09T09:00:00Z', op: 'add', id: 'relay01', text: 'wire the relay board', pri: 'now' }) + '\n',
)

const MSG = '/minerva the relay board wiring is finished — and capture: benchmark the pooled gate at 4 slots'
const cfg = {
  ...base,
  sends: [
    { atTick: 30, data: MSG },
    { atTick: 42, data: '\r' },
  ],
  // ↵ at ~8.4s; one schema-forced Sonnet-5 call typically settles in 3–10s —
  // give it ~40s of post-↵ ticks.
  total: 240,
  out: '/tmp/grid-live-minerva.json',
}
writeFileSync('/tmp/vshot-live-minerva.json', JSON.stringify(cfg))
const res = spawnSync(
  '/usr/bin/python3',
  [join(ROOT, 'scripts/ui/vshot.py'), '/tmp/vshot-live-minerva.json'],
  { encoding: 'utf8', timeout: vshotBudgetMs(120_000), env: { ...process.env } },
)
if (res.status !== 0) {
  console.log(`  [FAIL] vshot exited ${res.status}: ${(res.stderr ?? '').slice(0, 300)}`)
  failures++
}

// ── The oracles ──
type Ev = { op: string; id?: string; text?: string; via?: string }
const journal = readFileSync(join(dir, 'journal.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(l => JSON.parse(l) as Ev)
const minted = journal.filter(e => e.op === 'add' && e.id !== 'relay01')
check('≥1 minerva-minted add landed in the journal', minted.length >= 1, minted.map(e => `"${e.text}"`).join(' · '))
const metaPath = join(dir, 'meta.json')
const meta = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, 'utf8')) as { lastChatAt?: string; lastReceipt?: string }) : {}
check('meta.lastChatAt stamped by the exchange', typeof meta.lastChatAt === 'string', meta.lastReceipt ?? '')
let text = ''
try {
  const g = JSON.parse(readFileSync('/tmp/grid-live-minerva.json', 'utf8')) as { grid: Array<Array<{ c: string }>> }
  text = g.grid.map(r => r.map(c => c.c ?? '').join('')).join('\n')
} catch {
  /* grid unreadable → the paint check below fails honestly */
}
check("reply painted in the transcript ('Minerva:')", text.includes('Minerva:'))
const closed = journal.some(e => e.op === 'done' && e.id === 'relay01' && e.via === 'minerva')
console.log(`  [${closed ? 'note' : 'note'}] seeded note closed via minerva: ${closed} (model judgment — reported, not asserted)`)
void gridToPng('/tmp/grid-live-minerva.json', '/tmp/live-minerva-chat.png').then(r => console.log('  png:', r.path))

cleanupScenario('tabula-empty')
console.log('')
if (failures > 0) {
  console.log(`❌ live-chat-e2e: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ live-chat-e2e: ALL GREEN (a real Sonnet-5 exchange landed validated ops)')
