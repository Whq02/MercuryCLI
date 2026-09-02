#!/usr/bin/env bun
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

  check(`[${cols}] collapsed thinking row paints (∴ Thinking)`, body.includes('∴ Thinking'))
  check(
    `[${cols}] disclosure cue ⌄ rides the thinking line`,
    /∴ Thinking\s*⌄/.test(body),
    'cue missing — the row would be a dead-end again',
  )
  check(
    `[${cols}] full reasoning NOT dumped in the default view`,
    !body.includes('bundle time'),
    'collapsed row leaked the prose',
  )
  check(
    `[${cols}] answer prose renders beneath`,
    body.includes('lock-step'),
  )
  console.log(`  → HTML: ${out}`)
}

cleanupScenario('thinking-row')

console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ' ✅ thinking disclosure row render-verified' : ` ✕ ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
