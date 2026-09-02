// ============================================================================
//  render-inline-history — the inline (main-screen) writer can never erase or
//  duplicate the operator's terminal history (task #69, the bounded-live-
//  region rebuild of frame-writer.ts).
//
//  BEFORE the rebuild, one /help + /status open/close cycle emitted 9× [2J +
//  9× [3J (clearTerminal full resets) and left pyte's HistoryScreen EMPTY —
//  the app deleted the operator's entire scrollback. The rebuild froze
//  everything above the live zone as print-once history (flushedRows), turned
//  the scrollback-diff resets into silent frozen-row drops, and made
//  resize/shrink-below-flush a NEW EPOCH (EL-clear the writer's own live rows
//  only + repaint the ≤viewport tail).
//
//  Oracles (the task-#69 acceptance contract):
//    · VSHOT_TEE raw bytes — ZERO \x1b[2J / \x1b[3J after boot
//    · pyte HistoryScreen replay — history NON-EMPTY after the modal cycle,
//      ZERO duplicated non-trivial lines across history+screen, and a clean
//      history→screen seam (one continuous document when scrolling up)
//    · the composer (with typed text) present at the bottom of the CONTENT
//      on the final screen — the prompt tracks the content tail, coherent
//      through two epochs + growth
//
//  Honest limitation: vshot's PTY is fixed-size, so the width-resize epoch
//  leg shares coverage with the (exercised) shrink-below-flush epoch path.
//  PTY-booting proof (≈25s): joins the suite under UI_RENDER=1.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_HOME, cleanupScenario, scenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const VSHOT = join(import.meta.dir, 'vshot.py')
const REPLAY = join(import.meta.dir, 'inline-history-replay.py')
const tee = '/tmp/render-inline-history.bin'
try { rmSync(tee) } catch { /* fresh */ }

const sends = [
  { atTick: 40, data: '/help\r' },
  { atTick: 62, data: '\x1b' },
  { atTick: 72, data: '/status\r' },
  { atTick: 95, data: '\x1b' },
  { atTick: 105, data: 'hello inline world' },
]
const cfgPath = '/tmp/render-inline-history-cfg.json'
writeFileSync(
  cfgPath,
  JSON.stringify({ ...scenario('resume-2turn', 120, 44), out: '/tmp/render-inline-history-grid.json', total: 120, sends }),
)
const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
  encoding: 'utf-8',
  timeout: vshotBudgetMs(150000),
  env: { ...process.env,
    // Split-home guard: bun-side writers and the stamp-defaulted dist must
    // resolve ONE home even outside the gate unit's pin (pinned home).
    MERCURY_CONFIG_DIR: CONFIG_HOME, VSHOT_TEE: tee },
})
cleanupScenario('resume-2turn')
if (res.status !== 0) {
  console.error(`✗ vshot failed: ${res.stderr?.slice(0, 300)}`)
  process.exit(1)
}

const rep = spawnSync('/usr/bin/python3', [REPLAY, tee, '120', '44', '30'], {
  encoding: 'utf-8',
  timeout: vshotBudgetMs(60000),
})
if (rep.status !== 0) {
  console.error(`✗ replay failed: ${rep.stderr?.slice(0, 400)}`)
  process.exit(1)
}
const r = JSON.parse(rep.stdout) as {
  erases: { boot: { ed2: number; ed3: number }; post: { ed2: number; ed3: number } }
  historyLen: number
  history: string[]
  screen: string[]
  dupes: Array<{ line: string; n: number }>
}

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures++
}

check(
  r.erases.post.ed2 === 0 && r.erases.post.ed3 === 0,
  `ZERO screen/scrollback erases after boot (ed2=${r.erases.post.ed2}, ed3=${r.erases.post.ed3}; pre-rebuild baseline was 9+9)`,
)
check(r.erases.boot.ed2 === 0 && r.erases.boot.ed3 === 0, 'boot itself emits no erases either')
check(r.historyLen > 0, `history survives the modal open/close cycle (${r.historyLen} rows; baseline was 0)`)
check(r.dupes.length === 0, `zero duplicated frames across history+screen (${r.dupes.length})`)
const screenText = r.screen.join('\n')
check(/hello inline world/.test(screenText), 'typed text renders in the composer')
check(/│❯ hello inline world/.test(screenText), 'the composer box carries the prompt (tracks the content tail)')
// The prompt is the CONTENT tail: no non-blank rows below the composer's
// closing border + its footer chrome (effort line) on the final screen.
const lastContent = r.screen.map(s => s.trim()).reduce((acc, s, i) => (s ? i : acc), 0)
// LAST ╰, not first: the bordered ResumeRecapCard precedes the
// composer on a resumed screen — the composer's box is the one that closes
// LAST; the first-match heuristic pinned the recap card and misread a
// correct tail as a 10-row violation.
const composerBottom = r.screen.reduce((acc, s, i) => (s.includes('╰') ? i : acc), -1)
check(
  composerBottom >= 0 && lastContent - composerBottom <= 2,
  `prompt sits at the content tail (composer ends @${composerBottom}, last content @${lastContent})`,
)

console.log(failures === 0 ? '✅ inline history GREEN' : `❌ inline history RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
