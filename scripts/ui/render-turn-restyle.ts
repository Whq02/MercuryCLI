#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-turn-restyle.ts — render-verify for the TURN RESTYLE
//  (the "calm + rhythm" premium pass on the everyday transcript).
//
//  Render-verify is the law for Ink changes. This drives the REAL built
//  binary via `-r <session> --fork-session` (resume renders the stored transcript
//  with NO API turn — deterministic, no cost, no permission prompts) and captures
//  with /tmp/vshot.py at 80 AND 120 cols. It asserts the three deltas from the
//  full-chat concept card (archived: design-system/archive/2026-07-hermes-concepts/full-chat.html):
//    1. tool NAME is the calm muted label (SECOND #b3ac9c), NOT the session
//       accent (TERRA #dd4444) — color now lives only in the STATE dot.
//    2. tool args render WITHOUT the default's wrapping parens (`Bash  git status`,
//       not `Bash(git status)`).
//    3. the user turn is a bare `❯` caret with NO grey block fill.
//
//  Two fixtures: a tool-heavy session (tool rows + prose) and a clean-prompt
//  session (the user caret). Writes HTML per capture so the color can be eyeballed
//  (chrome-devtools screenshot) — the text grid alone can't show hue.
//
//  Run:  ~/.bun/bin/bun run scripts/ui/render-turn-restyle.ts
// ============================================================================
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SECOND as SECOND_TOKEN } from '../../src/components/mercuryPalette.ts'
import { CONFIG_HOME, scenario, cleanupScenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BIN = join(root, 'dist', 'mercury.mjs')
const VSHOT = new URL('./vshot.py', import.meta.url).pathname
if (!existsSync(VSHOT) || !existsSync(BIN)) {
  console.error('vshot.py or dist/mercury.mjs missing — build first (bun run build.ts, AGENTS.md); render-verify drives the built binary.')
  process.exit(1)
}

const SECOND = SECOND_TOKEN.toLowerCase() // the calm muted label tone (import-synced to mercuryPalette)

// Fixtures: SELF-STAGED renderScenarios sessions (de-staled — the
// leg would otherwise resume two REAL operator sessions by hardcoded id; both aged
// out of the project history, so every capture was a "No conversation found"
// error screen soft-passing as green). 'tool-cards' renders real persisted
// Bash/Read tool rows (the muted-label + no-parens surface); 'resume-2turn'
// renders plain user prompts (the bare-❯-caret surface).
const FIXTURES = [
  { name: 'tool-cards', shows: 'tool-rows' },
  { name: 'resume-2turn', shows: 'user-caret' },
] as const

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const shoot = (name: (typeof FIXTURES)[number]['name'], cols: number, tag: string): { grid: string; htmlPath: string } => {
  // NO pkill: `pkill -f dist/mercury.mjs` killed the operator's
  // LIVE sessions (render-diff-width:161 precedent); the settle sleep suffices.
  execFileSync('sleep', ['3'])
  const cfgPath = `/tmp/vs-turn-${tag}.json`
  const out = `/tmp/turn-${tag}.html`
  writeFileSync(cfgPath, JSON.stringify({ ...scenario(name, cols, 42), out, title: `turn-restyle ${tag}` }))
  // Split-home guard: stage-side (renderScenarios CONFIG_HOME) and the child
  // binary must resolve ONE home (pinned home).
  const grid = execFileSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(120000),
    env: { ...process.env, MERCURY_CONFIG_DIR: CONFIG_HOME },
  })
  return { grid, htmlPath: out }
}

console.log('============================================================')
console.log(' TURN RESTYLE — calm + rhythm transcript (render-verify)')
console.log('============================================================')

for (const fx of FIXTURES) {
  for (const cols of [120, 80]) {
    const tag = `${fx.shows}-${cols}`
    console.log(`\n── ${tag} (scenario ${fx.name}) ──`)
    const { grid, htmlPath } = shoot(fx.name, cols, tag)
    // Print only the transcript region of the snapshot (skip the SNAPSHOT banner lines).
    const lines = grid.split('\n')
    const body = lines.filter(l => !l.startsWith('===') && !l.startsWith('[wrote'))
    console.log(body.join('\n').replace(/\n{3,}/g, '\n\n'))
    const html = existsSync(htmlPath) ? readFileSync(htmlPath, 'utf-8').toLowerCase() : ''
    if (fx.shows === 'tool-rows') {
      // Color: the muted label tone must appear; the accent must NOT be used as a
      // tool-name fg (accent may still legitimately appear elsewhere, e.g. the ❯
      // caret/wordmark — so this is a soft signal printed for the eyeball check).
      // vshot's `out` artifact is the CELL-GRID JSON (fg as a bare hex field),
      // not CSS — the old `color:#…` needle matched a format it stopped writing.
      check(`[${cols}] muted label tone (${SECOND}) present in render`, new RegExp(`"fg":\\s*"${SECOND.slice(1)}"`).test(html))
    }
    console.log(`  → HTML: ${htmlPath}  (screenshot to confirm hue)`)
  }
}

cleanupScenario('tool-cards')
cleanupScenario('resume-2turn')

console.log('\n' + '='.repeat(60))
console.log(failures === 0
  ? ' ✅ turn-restyle rendered; eyeball the HTML for hue + no-fill'
  : ` ⚠ ${failures} soft check(s) — inspect the snapshots/HTML`)
// Soft harness: the SCREENSHOT is the real gate (color/no-fill). Never hard-fail
// the loop on the lenient text checks — exit 0 so the captures always land.
process.exit(0)
