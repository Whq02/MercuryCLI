#!/usr/bin/env bun
// ============================================================================
//  scripts/tabula/live-repl-e2e.ts — the BILLED live E2E for the TABULA
//  card's MINERVA ask line.
//  NOT gate-joined (real API usage — the live-console-e2e precedent).
//  Run explicitly:  ~/.bun/bin/bun run scripts/tabula/live-repl-e2e.ts
//
//  Drives the REAL binary in a PTY against a pid-scratch notepad: Tab into
//  the lanes rail, ↓-walk onto the ask line, TYPE a message (auto-compose —
//  the chars land in the rail), ↵ — one real Sonnet-5 exchange through
//  runMinervaMessage, grounded in the live session digest.
//
//  Oracles: the JOURNAL (a minerva-minted add + the seeded note closed
//  via:'minerva') + the rail's receipt row in the final frame.
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
console.log(' LIVE rail-REPL E2E — Tab · walk · type · ↵ · real Sonnet-5')
console.log('============================================================')

const base = scenario('tabula-empty', 120, 44)
const slug = ROOT.replace(/[^a-zA-Z0-9]/g, '-')
const dir = join(process.env.MERCURY_TABULA_DIR!, slug)
mkdirSync(dir, { recursive: true })
writeFileSync(
  join(dir, 'journal.jsonl'),
  JSON.stringify({ t: '2026-07-09T09:00:00Z', op: 'add', id: 'relay01', text: 'wire the relay board', pri: 'now' }) + '\n',
)

const TAB = String.fromCharCode(9)
const DOWN = String.fromCharCode(27) + '[B'
// Row model with ONE open note: seat:self(0) · RECENT ×3 (1-3) · tabula note
// row (4) · tabula:ask (5) — ↓×5 rests on the ask line.
const MSG = 'the relay board wiring is finished, and capture: benchmark the pooled gate at 4 slots'
const cfg = {
  ...base,
  sends: [
    { atTick: 30, data: TAB },
    { atTick: 34, data: DOWN.repeat(5) },
    { atTick: 40, data: MSG },
    { atTick: 48, data: '\r' },
  ],
  // ↵ at ~9.6s; one schema-forced Sonnet-5 call settles in 3–10s.
  total: 240,
  out: '/tmp/grid-live-repl.json',
}
writeFileSync('/tmp/vshot-live-repl.json', JSON.stringify(cfg))
const res = spawnSync(
  '/usr/bin/python3',
  [join(ROOT, 'scripts/ui/vshot.py'), '/tmp/vshot-live-repl.json'],
  { encoding: 'utf8', timeout: vshotBudgetMs(120_000), env: { ...process.env } },
)
if (res.status !== 0) {
  console.log(`  [FAIL] vshot exited ${res.status}: ${(res.stderr ?? '').slice(0, 300)}`)
  failures++
}

type Ev = { op: string; id?: string; text?: string; via?: string }
const journal = readFileSync(join(dir, 'journal.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(l => JSON.parse(l) as Ev)
const minted = journal.filter(e => e.op === 'add' && e.id !== 'relay01')
check('≥1 minerva-minted add landed via the rail ↵', minted.length >= 1, minted.map(e => `"${e.text}"`).join(' · '))
const meta = existsSync(join(dir, 'meta.json'))
  ? (JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { lastChatAt?: string; lastReceipt?: string })
  : {}
check('meta.lastChatAt stamped', typeof meta.lastChatAt === 'string', meta.lastReceipt ?? '')
let railText = ''
try {
  const g = JSON.parse(readFileSync('/tmp/grid-live-repl.json', 'utf8')) as { grid: Array<Array<{ c: string }>> }
  railText = g.grid.map(r => r.slice(0, 25).map(c => c.c || ' ').join('')).join('\n')
} catch {
  /* unreadable grid → the paint check fails honestly */
}
check('receipt row painted IN THE RAIL (✦ + reply)', /✦/.test(railText), railText.split('\n').find(l => l.includes('✦'))?.trim() ?? '')
const closed = journal.some(e => e.op === 'done' && e.id === 'relay01' && e.via === 'minerva')
console.log(`  [note] seeded note closed via minerva: ${closed} (model judgment — reported, not asserted)`)
void gridToPng('/tmp/grid-live-repl.json', '/tmp/live-repl-rail.png').then(r => console.log('  png:', r.path))

cleanupScenario('tabula-empty')
console.log('')
if (failures > 0) {
  console.log(`❌ live-repl-e2e: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ live-repl-e2e: ALL GREEN (the rail REPL drove a real exchange)')
