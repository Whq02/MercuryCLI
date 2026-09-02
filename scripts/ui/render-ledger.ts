#!/usr/bin/env bun
// render-ledger.ts — pixel render-verify for the /ledger operator reader
// Drives the real
// binary through the generic 'ledger' scenario (renderScenarios.ts: /ledger ↵)
// at 80 and 120 cols; render-tui's oracle rejects blank/chrome-less captures,
// and we additionally assert the view's header line painted. This repo's own
// .claude/evolution ledgers provide real rows; an empty checkout still passes —
// the honest EmptyState carries the same 'ledger' title the header check greps.
//
//  Run:  UI_RENDER=1 ~/.bun/bin/bun run scripts/ui/render-ledger.ts
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const BUN = process.env.BUN ?? `${process.env.HOME}/.bun/bin/bun`
let fail = 0

for (const cols of [80, 120]) {
  try {
    execFileSync(BUN, ['run', join(ROOT, 'scripts/ui/render-tui.ts'), '--scenario', 'ledger', '--cols', String(cols), '--out', `/tmp/tui-ledger-${cols}.png`], {
      cwd: ROOT, stdio: 'pipe', timeout: 150000,
    })
    const grid = JSON.parse(readFileSync(`/tmp/grid-${cols}.json`, 'utf8')) as { grid: Array<Array<{ c: string }>> }
    const text = grid.grid.map(row => row.map(cell => cell.c).join('')).join('\n')
    const ok = text.includes('Mercury — ledger') || text.includes('evolution-ledger rows')
    console.log(`  ${ok ? '✓' : '✗'} ${cols} cols — ledger view painted`)
    if (!ok) fail = 1
  } catch (e) {
    console.log(`  ✗ ${cols} cols — capture failed: ${(e as Error).message.split('\n')[0]}`)
    fail = 1
  }
}

console.log(fail === 0 ? '✅ render-ledger GREEN' : '❌ render-ledger RED')
process.exit(fail)
