#!/usr/bin/env bun
// render-help-commands.ts — pixel render-verify for the /help commands tab's
// fork domain grouping (commandDomains.ts headers instead of the alphabetical
// ~150-command wall). Drives the REAL binary through
// the help-commands scenario (renderScenarios.ts: /help → ↵ → tab) at 80 and
// 120 cols; render-tui's oracle rejects blank/chrome-less captures, and we
// additionally assert the first group header actually painted.
//
// The 120-col run pins MERCURY_HELM_HOME=0 (deck-strip home): under the
// interactive Helm cockpit the vshot PTY's final grid comes back fully blank
// for this drive (a pyte capture artifact — the same drive against the live
// binary at 120 paints correctly, verified by a raw-PTY dump).
//
//  Run:  UI_RENDER=1 ~/.bun/bin/bun run scripts/ui/render-help-commands.ts
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const BUN = process.env.BUN ?? `${process.env.HOME}/.bun/bin/bun`
let fail = 0

for (const cols of [80, 120]) {
  const env = { ...process.env, ...(cols === 120 ? { MERCURY_HELM_HOME: '0' } : {}) }
  try {
    execFileSync(BUN, ['run', join(ROOT, 'scripts/ui/render-tui.ts'), '--scenario', 'help-commands', '--cols', String(cols), '--out', `/tmp/tui-help-commands-${cols}.png`], {
      cwd: ROOT, env, stdio: 'pipe', timeout: 150000,
    })
    // The oracle passed (chrome painted); now assert the GROUPED tab painted —
    // the first domain header must be in the captured cell grid.
    const grid = JSON.parse(readFileSync(`/tmp/grid-${cols}.json`, 'utf8')) as { grid: Array<Array<{ c: string }>> }
    const text = grid.grid.map(row => row.map(cell => cell.c).join('')).join('\n')
    const ok = text.includes('crew & delegation')
    console.log(`  ${ok ? '✓' : '✗'} ${cols} cols — domain header painted`)
    if (!ok) fail = 1
  } catch (e) {
    console.log(`  ✗ ${cols} cols — capture failed: ${(e as Error).message.split('\n')[0]}`)
    fail = 1
  }
}

console.log(fail === 0 ? '✅ render-help-commands GREEN' : '❌ render-help-commands RED')
process.exit(fail)
