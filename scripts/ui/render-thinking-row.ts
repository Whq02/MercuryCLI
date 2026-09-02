#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-thinking-row.ts — render-verify for the thinking
//  disclosure row.
//
//  Drives the REAL built binary via --resume onto the 'thinking' fixture (an
//  assistant [thinking, text] message) and captures with vshot.py at 80 AND
//  120 cols. Asserts the finalized thinking row paints as the collapsed
//  thinking-grammar line (`✳︎ thinking… ⌄` — the old dispatch nulled it and
//  the reasoning was silently unreachable in the default view) with the
//  answer prose still beneath it. HARD-fails: the needle is deterministic
//  text, not hue. The glyph's text-presentation selector is zero-width, so
//  the cell grid may or may not carry it — the needle admits both.
//
//  Run:  ~/.bun/bin/bun run scripts/ui/render-thinking-row.ts
// ============================================================================
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_HOME, scenario, cleanupScenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BIN = join(root, 'dist', 'mercury.mjs')
const VSHOT = new URL('./vshot.py', import.meta.url).pathname
if (!existsSync(VSHOT) || !existsSync(BIN)) {
  console.error('vshot.py or dist/mercury.mjs missing — build first (bun run build.ts, AGENTS.md); render-verify drives the built binary.')
  process.exit(1)
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

// The grammar's row: glyph (selector optional in a cell grid), lowercase word,
// ellipsis; the fold cue follows on the same line.
const ROW = /✳︎? thinking…/
const ROW_WITH_CUE = /✳︎? thinking…\s*⌄/

for (const cols of [120, 80]) {
  console.log(`\n── thinking-row @ ${cols} cols ──`)
  execFileSync('sleep', ['2'])
  const cfgPath = `/tmp/vs-thinking-${cols}.json`
  const out = `/tmp/thinking-row-${cols}.html`
  writeFileSync(
    cfgPath,
    JSON.stringify({ ...scenario('thinking-row', cols, 42), out, title: `thinking-row ${cols}` }),
  )
  const grid = execFileSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(120000),
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: CONFIG_HOME,
    },
  })
  const body = grid
    .split('\n')
    .filter(l => !l.startsWith('===') && !l.startsWith('[wrote'))
    .join('\n')
  console.log(body.replace(/\n{3,}/g, '\n\n'))

  check(`[${cols}] collapsed thinking row paints (the grammar's glyph + lowercase word)`, ROW.test(body))
  check(
    `[${cols}] disclosure cue ⌄ rides the thinking line`,
    ROW_WITH_CUE.test(body),
    'cue missing — the row would be a dead-end again',
  )
  check(`[${cols}] no sentence-case or accent-era spelling survives`, !body.includes('Thinking'))
  check(
    `[${cols}] full reasoning NOT dumped in the default view`,
    !body.includes('bundle time'),
    'collapsed row leaked the prose',
  )
  check(
    // Single-word needle: the sentence wraps at 80 cols, so a phrase spanning
    // the wrap boundary can never match the cell grid.
    `[${cols}] answer prose renders beneath`,
    body.includes('lock-step'),
  )
  console.log(`  → HTML: ${out}`)
}

cleanupScenario('thinking-row')

console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ' ✅ thinking disclosure row render-verified' : ` ✕ ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
