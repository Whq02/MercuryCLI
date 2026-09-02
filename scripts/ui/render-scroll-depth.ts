// ============================================================================
//  render-scroll-depth — deep history is REACHABLE in a long virtualized
//  session.
//
//  The failure this pins: in a 300-turn resumed session, 20 PageUps stalled
//  at turn ~169 — each press moved only HALF a viewport (18 rows) while the
//  backward extension ground at ~600ms/press, so past chat history FELT
//  unreachable ("can't scroll to past chat-history", the blank-spacer
//  screenshot). scroll:pageUp/Down now jump a FULL page (viewport−2, classic
//  pager; ctrl+u/d keep the half-page lineage) — the same 22-press walk must
//  land in single-digit turns, proving the gesture covers what it promises.
//  PTY-booting proof (≈30s): joins the suite under UI_RENDER=1.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { resolveProofHome } from '../lib/proofHome.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(new URL('.', import.meta.url).pathname, '../..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts/ui/vshot.py')
// The proof's config home (scripts/lib/proofHome.ts): the inherited pin, else
// a fresh seeded scratch — the fixture below and the spawned binary share it.
const CONFIG_HOME = resolveProofHome([REPO.normalize('NFC')])
const PROJECTS = join(CONFIG_HOME, 'projects', sanitizePath(REPO.normalize('NFC')))
const SID = `00000000-aaaa-bbbb-ffff-${(process.pid % 0xffffff).toString(16).padStart(12, '0')}`

const base = (extra: Record<string, unknown>) => ({
  isSidechain: false, userType: 'external', entrypoint: 'cli',
  cwd: REPO, sessionId: SID, version: '1.0.0-beta.1', gitBranch: 'main', ...extra,
})
const lines: unknown[] = []
let prev: string | null = null
for (let i = 1; i <= 300; i++) {
  const uuid = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
  lines.push(base({
    parentUuid: prev, type: 'user', uuid,
    message: { role: 'user', content: `turn ${i}: deep-scroll probe row with enough words to hold a line` },
    timestamp: `2026-06-19T12:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
  }))
  prev = uuid
}
if (!existsSync(PROJECTS)) mkdirSync(PROJECTS, { recursive: true })
const fixture = join(PROJECTS, `${SID}.jsonl`)
writeFileSync(fixture, lines.map(l => JSON.stringify(l)).join('\n') + '\n')

const PAGEUP = '\x1b[5~'
// 48 presses (was 28): since the Helm cockpit became the fork DEFAULT, this
// leg scrolls the CENTER PANEL — its viewport is ~21-25 rows at 120×44 (rails
// + banner + status band + bordered panel chrome), not the ~34-row full-width
// transcript the original math assumed (28 presses stalled at turn ~95).
// 48 × ~21 rows ≈ 1000 ≥ the ~872-row fixture — the walk must hit the top in
// the REAL default UI, which is the operator ask this leg pins.
const sends = Array.from({ length: 48 }, (_, i) => ({ atTick: 45 + i * 3, data: PAGEUP }))
const grid = '/tmp/render-scroll-depth-grid.json'
const cfgPath = '/tmp/render-scroll-depth-cfg.json'
writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN, '--resume', SID], sends, total: 245, cols: 120, rows: 44, out: grid }))
const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
  encoding: 'utf-8', timeout: vshotBudgetMs(220000),
  // Split-home guard: the fixture is written under CONFIG_HOME (the proof's
  // own home); the env-less fork child resolves ITS OWN ~/.mercury since the
  // sovereign-home flip and boots onto "No conversation found" —
  // pin the pair to ONE home like every scenario()-based sibling.
  env: { ...process.env, MERCURY_CONFIG_DIR: CONFIG_HOME },
})
try { rmSync(fixture) } catch { /* fixture */ }
if (res.status !== 0) {
  console.error(`✗ vshot failed: ${res.stderr?.slice(0, 300)}`)
  process.exit(1)
}

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures++
}
const g = JSON.parse(readFileSync(grid, 'utf-8')) as { grid: Array<Array<{ c: string }>> }
const rows = g.grid.map(line => line.map(c => c.c).join('').trimEnd())
const nums = rows
  .map(r => /turn (\d+):/.exec(r)?.[1])
  .filter((x): x is string => !!x)
  .map(Number)
check(nums.length > 0, `transcript rows visible after the walk (${nums.length})`)
const lowest = nums.length ? Math.min(...nums) : Infinity
// 28 full pages × ~34 rows ≈ 952 ≥ the ~872-row content: the walk must hit
// the natural top (scrollTop 0 — there is no listOrigin floor;
// the critter header sits above turn 1, both in the top
// viewport). The walk is deterministic — 24 presses landed at turn 17
// (= exactly 24×34 rows), the half-page pre-fix stalled at ~169.
check(lowest <= 3, `deep history reached to the floor — lowest visible turn ${lowest} (pre-fix stall: ~169)`)

console.log(failures === 0 ? '✅ scroll depth GREEN' : `❌ scroll depth RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
