#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-keys-escape.ts — the input atlas's advertised Escape
//  actually closes it.
//
//  CommandCenter on a captureInput-false surface renders ' · esc close' and
//  binds NOTHING — the CHILD owns Escape by convention (the palette's
//  decodeNavKey 'cancel' branch is the sanctioned pattern). The atlas's
//  browse-mode useInput handled move/page/tab/ctrl keys and dropped
//  'cancel' on the floor: Escape did nothing while the footer advertised it.
//
//  RENDER truth, not a unit fact: the capture opens /keys, waits for the
//  atlas frame, sends a bare ESC, settles, and this prover asserts the atlas
//  is ABSENT from the final grid (vshot itself only asserts presence). The
//  guarded red: a final frame still containing the atlas.
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { scenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

function capture(name: string, cols: number, rows: number): { final: string; atSend: string } {
  const gridPath = `/tmp/grid-${name}.json`
  const cfgPath = `/tmp/vshot-${name}.json`
  const cfg = { ...scenario(name, cols, rows), out: gridPath }
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfgPath], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(180000),
    env: { ...process.env },
  })
  if (res.status !== 0) {
    throw new Error(`vshot failed for ${name}: ${res.stdout}\n${res.stderr}`)
  }
  const parsed = JSON.parse(readFileSync(gridPath, 'utf-8')) as {
    grid?: Array<Array<{ c?: string }>>
    marks?: Array<{ label: string; grid: Array<Array<{ c?: string }>> }>
  }
  const text = (g: Array<Array<{ c?: string }>> | undefined): string =>
    Array.isArray(g) ? g.map(row => row.map(cell => cell.c ?? ' ').join('')).join('\n') : ''
  return {
    final: text(parsed.grid),
    atSend: text(parsed.marks?.find(m => m.label === 'atlas-open')?.grid),
  }
}

console.log('input atlas — advertised Escape closes it')

for (const cols of [80, 120]) {
  console.log(`\n— keys-escape @${cols} —`)
  const { final, atSend } = capture('keys-escape', cols, 44)
  // PRESENCE PRECONDITION: atTick is a hard deadline,
  // so the ESC fires even if the atlas never opened — asserting only the
  // final ABSENCE would pass vacuously on an open-regression. The mark's
  // grid must show the atlas AT the send.
  check(
    `@${cols}: the atlas was OPEN when the ESC was sent (no vacuous pass)`,
    /input atlas/.test(atSend),
    'the atlas never opened — this capture proves nothing about Escape',
  )
  check(
    `@${cols}: the atlas is GONE after Escape`,
    !/input atlas/.test(final),
    'the final frame still shows the atlas — Escape is dead in browse mode',
  )
  check(`@${cols}: the session view is back`, /for commands/.test(final))
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
