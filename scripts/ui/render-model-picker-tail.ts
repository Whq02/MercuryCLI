#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-model-picker-tail.ts — the /model TAIL-SCROLL invariant:
//  the focused row is FULLY visible at every list position, expansion
//  included — pinned at the position that broke (End → the last seat-slot
//  row, whose focused card grows by a border and detail lines).
//
//  The defect class (lane DS parcel 6, operator screenshot): the window
//  fit by INDEX COUNT while its painted lines overflowed the modal slot —
//  the slot bottom-clipped exactly the focused seat card (its detail line
//  rode below the cut) along with everything under it (meter · effort ·
//  footer · the panel's own closing border). The fix measures PAINTED
//  lines (fitMeasuredWindow); this prover drives the REAL binary to the
//  real tail and asserts the paint that the clip used to eat:
//    • the panel's closing border is the BOTTOM-MOST ink on screen — a
//      clipped panel ends in a row/text line instead;
//    • the focused seat row's expansion is on screen (the id-line naming
//      the seat-slot precedence chain — full mode), and the footer hints
//      survive;
//    • a focus caret/card exists at all (End actually landed the tail row).
//
//  Heavy (boots the built binary in a PTY × 2 geometries) ⇒ JOINS the UI
//  suite only under UI_RENDER=1, like every render-*.ts. Build first.
//  Run:  UI_RENDER=1 ~/.bun/bin/bun run scripts/ui/render-model-picker-tail.ts
// ============================================================================
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { resolveProofHome } from '../lib/proofHome.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const RUNTIME_CWD = join(import.meta.dir, '..', '..')
const REPO = RUNTIME_CWD
const CONFIG_HOME = resolveProofHome([RUNTIME_CWD])
const PROJECTS = join(CONFIG_HOME, 'projects', sanitizePath(RUNTIME_CWD))
const VSHOT = new URL('./vshot.py', import.meta.url).pathname
const BIN = join(REPO, 'dist', 'mercury.mjs')
const SID = '00000000-aaaa-bbbb-cccc-00000000d71e' // deterministic throwaway session

function buildSession(): string {
  const line = {
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd: RUNTIME_CWD,
    sessionId: SID,
    version: '1.0.0-beta.1',
    gitBranch: 'main',
    parentUuid: null,
    type: 'user',
    message: { role: 'user', content: 'boot into the repl' },
    uuid: '00000000-0000-4000-8000-000000000001',
    timestamp: '2026-06-19T10:00:01.000Z',
  }
  if (!existsSync(PROJECTS)) mkdirSync(PROJECTS, { recursive: true })
  const path = join(PROJECTS, `${SID}.jsonl`)
  writeFileSync(path, JSON.stringify(line) + '\n')
  return path
}

function shoot(cols: number, rows: number): string {
  const grid = `/tmp/model-picker-tail-${cols}x${rows}.json`
  const cfg = {
    argv: ['node', BIN, '--resume', SID],
    // Type /model, ↵ mounts the picker, End (\x1b[F → the 'last' nav axis)
    // lands the cursor on the LAST seat-slot row — the tail that clipped.
    sends: [
      { atTick: 30, data: '/model', awaitText: '❯', minTick: 5 },
      { afterPrevTicks: 6, data: '\r' },
      { afterPrevTicks: 10, data: '\x1b[F' },
    ],
    total: 64,
    cols,
    rows,
    out: grid,
    title: `model-picker-tail @ ${cols}x${rows}`,
  }
  const cfgPath = `/tmp/vshot-model-tail-${cols}x${rows}.json`
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: CONFIG_HOME,
    },
    timeout: vshotBudgetMs(45000),
  })
  return (res.stdout || '') + (res.stderr ? `\n[stderr] ${res.stderr}` : '')
}

console.log('============================================================')
console.log(' /model tail-scroll render-verify (End → last seat slot)')
console.log('============================================================')

buildSession()

let failures = 0
function expect(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

for (const [cols, rows] of [[120, 44], [80, 24]] as const) {
  const scr = shoot(cols, rows)
  const lines = scr.split('\n')
  // The tier is read FROM THE CAPTURE (the CHOOSE banner is compact-hidden)
  // — the modal slot decides the tier, never a guess from terminal rows.
  const compactTier = !/CHOOSE A MODEL/.test(scr)
  console.log(`\n── @ ${cols}×${rows} (${compactTier ? 'compact' : 'full'} tier) ──`)
  expect('the picker mounted', /Mercury — model/.test(scr))
  // The tail invariant, structural form: the bottom-most ink on screen is
  // the panel's OWN closing border — a clipped panel ends mid-content.
  const lastInk = [...lines].reverse().find(l => l.trim().length > 0) ?? ''
  expect('the panel closes on screen (bottom-most ink is its ╰ border)', lastInk.includes('╰'), JSON.stringify(lastInk.slice(0, 60)))
  // The focused tail row is actually there (End landed): full mode paints
  // the seat id-line + the bordered card; compact paints the ❯ caret row.
  if (compactTier) {
    expect('compact: the focused (❯) row is on screen', lines.some(l => l.includes('❯')))
    expect('compact: the footer hints survive below the rows', /esc close/.test(scr))
  } else {
    expect('full: the seat-slot id-line is on screen (the expansion the clip ate)', /seat slot · precedence: env pin/.test(scr))
    expect('full: the footer hints survive below the rows', /esc close/.test(scr))
    expect('full: the ↑ window counter tells the cut truth at the tail', /↑ \d+ more/.test(scr))
  }
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('✅ /model TAIL RENDER-VERIFY PASS — the focused tail row paints whole')
else console.log(`❌ ${failures} /model TAIL CHECK(S) FAILED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
