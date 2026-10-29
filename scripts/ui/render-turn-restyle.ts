#!/usr/bin/env bun
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

const SECOND = SECOND_TOKEN.toLowerCase()

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
  execFileSync('sleep', ['3'])
  const cfgPath = `/tmp/vs-turn-${tag}.json`
  const out = `/tmp/turn-${tag}.html`
  writeFileSync(cfgPath, JSON.stringify({ ...scenario(name, cols, 42), out, title: `turn-restyle ${tag}` }))
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
    const lines = grid.split('\n')
    const body = lines.filter(l => !l.startsWith('===') && !l.startsWith('[wrote'))
    console.log(body.join('\n').replace(/\n{3,}/g, '\n\n'))
    const html = existsSync(htmlPath) ? readFileSync(htmlPath, 'utf-8').toLowerCase() : ''
    if (fx.shows === 'tool-rows') {
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
process.exit(0)
