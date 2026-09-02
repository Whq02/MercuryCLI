#!/usr/bin/env bun
// scripts/ui/prove-latency-receipts.ts — deterministic input→paint receipts
// The REAL binary boots in a PTY with INK_WRITE_TEE (the
// production write path stamps every terminal write with wall-clock ms) and
// vshot's send receipts (each keypress's send stamped the same way). The
// receipt per key = the first tee write at ts ≥ sendTs. Laws:
//   §1 every settled-idle printable key paints within the GENEROUS
//      deterministic ceiling (300ms — a laptop under gate load; the observed
//      p50/p95 are printed and recorded in the ledger, far tighter);
//   §2 the receipts exist at all (the seam stays wired — a broken tee or a
//      dead echo path fails loudly, never silently).
// Hermetic: owns its config home (the §2.F law), pinned before the dynamic
// renderScenarios import.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const RUN_HOME = join(tmpdir(), `latency-home-${process.pid}`)
rmSync(RUN_HOME, { recursive: true, force: true })
mkdirSync(RUN_HOME, { recursive: true })
const REPO = join(import.meta.dir, '..', '..')
writeFileSync(
  join(RUN_HOME, '.claude.json'),
  JSON.stringify({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    numStartups: 10,
    theme: 'dark',
    projects: { [REPO]: { hasTrustDialogAccepted: true } },
    ...(process.env.ANTHROPIC_API_KEY
      ? { customApiKeyResponses: { approved: [process.env.ANTHROPIC_API_KEY.slice(-20)], rejected: [] } }
      : {}),
  }),
)
writeFileSync(join(RUN_HOME, 'settings.json'), JSON.stringify({}))
process.env.MERCURY_CONFIG_DIR = RUN_HOME
const { scenario, cleanupScenario } = await import('./renderScenarios.ts')

let fail = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

const cfg = scenario('frame', 100, 30) as Record<string, unknown>
const gridPath = join(RUN_HOME, 'grid.json')
const cfgPath = join(RUN_HOME, 'cfg.json')
const teePath = join(RUN_HOME, 'tee.jsonl')
// Five printable keys, well after settle (ticks are 200ms), spaced so each
// echo is attributable to its own key.
writeFileSync(
  cfgPath,
  JSON.stringify({
    ...cfg,
    out: gridPath,
    total: 52,
    sends: [
      // The first key waits for the painted composer (cold boots pass tick
      // 30 pre-mount — the key was swallowed and every receipt cascaded);
      // the fixed tick stays as the hard deadline.
      { atTick: 60, minTick: 8, awaitText: '❯', awaitSettleTicks: 2, data: 'h' },
      { atTick: 34, data: 'e' },
      { atTick: 38, data: 'l' },
      { atTick: 42, data: 'l' },
      { atTick: 46, data: 'o' },
    ],
  }),
)
const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfgPath], {
  encoding: 'utf-8',
  timeout: vshotBudgetMs(90_000),
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: RUN_HOME,
    MERCURY_AWAY_SUMMARY: '0',
    INK_WRITE_TEE: teePath,
  },
})
cleanupScenario('frame')
if (res.status !== 0) {
  console.log(`FAIL  capture ran — ${res.stderr?.slice(0, 300)}`)
  rmSync(RUN_HOME, { recursive: true, force: true })
  process.exit(1)
}
const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as {
  grid: Array<Array<{ c: string }>>
  sendReceipts?: Array<{ atTick: number; ts: number }>
}
const tee = readFileSync(teePath, 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map(l => JSON.parse(l) as { ts: number; len: number })
rmSync(RUN_HOME, { recursive: true, force: true })

t('send receipts recorded', (payload.sendReceipts?.length ?? 0) === 5, `${payload.sendReceipts?.length ?? 0}`)
t('the production write tee is live', tee.length > 3, `${tee.length} writes`)
const text = payload.grid.map(r => r.map(c => c.c).join('')).join('\n')
t('the typed text landed (echo is real, not assumed)', text.includes('hello'))

const CEILING_MS = 300
const latencies: number[] = []
for (const s of payload.sendReceipts ?? []) {
  const first = tee.find(w => w.ts >= s.ts)
  if (!first) {
    t(`key@tick${s.atTick}: a paint followed the key`, false)
    continue
  }
  const d = first.ts - s.ts
  latencies.push(d)
  t(`key@tick${s.atTick}: input→paint ${d}ms ≤ ${CEILING_MS}ms`, d <= CEILING_MS)
}
if (latencies.length > 0) {
  const sorted = [...latencies].sort((a, b) => a - b)
  const p50 = sorted[Math.floor(sorted.length / 2)]
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
  console.log(`  observed: p50=${p50}ms · p95=${p95}ms · all=[${sorted.join(', ')}]ms (ceiling ${CEILING_MS}ms is the deterministic gate; the ledger records the observed numbers)`)
}

if (fail) {
  console.log('\n❌ latency receipts — failures above')
  process.exit(1)
}
console.log('\n✅ latency receipts — settled-idle keys paint inside the ceiling on the production write path')
