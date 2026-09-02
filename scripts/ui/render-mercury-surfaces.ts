#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveProofHome } from '../lib/proofHome.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const BUN = process.env.BUN || join(process.env.HOME!, '.bun', 'bin', 'bun')
const CONFIG_HOME = resolveProofHome([process.cwd()])
const VSHOT = new URL('./vshot.py', import.meta.url).pathname
const BIN = join(REPO, 'dist', 'mercury.mjs')

if (!existsSync(VSHOT)) {
  console.error(`vshot.py not found at ${VSHOT} — the render-verify harness (scripts/ui/vshot.py) is required.`)
  process.exit(1)
}

console.log('▶ building dist/mercury.mjs …')
const build = spawnSync(BUN, ['run', 'build.ts'], { cwd: REPO, encoding: 'utf-8' })
if (build.status !== 0) {
  console.error(build.stdout || '', build.stderr || '')
  console.error('❌ build failed')
  process.exit(1)
}

function shoot(cmd: string, cols: number): string {
  const out = `/tmp/hermes-surface-${cmd.replace(/\//g, '')}-${cols}.html`
  const cfg = {
    argv: ['node', BIN],
    sends: [{ atTick: 30, data: cmd }, { atTick: 38, data: '\r' }],
    total: 56,
    cols,
    rows: 40,
    out,
    title: `${cmd} @ ${cols}`,
  }
  const cfgPath = `/tmp/vs-surface-${cmd.replace(/\//g, '')}-${cols}.json`
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf-8',
    env: { ...process.env,
    MERCURY_CONFIG_DIR: CONFIG_HOME },
    timeout: vshotBudgetMs(30000),
  })
  return (res.stdout || '') + (res.stderr ? `\n[stderr] ${res.stderr}` : '')
}

let failures = 0
function expect(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
}

console.log('============================================================')
console.log(' /fullscreen + /model render-verify (vshot, 80 & 120)')
console.log('============================================================')

const model80 = shoot('/model', 80)
const model120 = shoot('/model', 120)
const fs80 = shoot('/fullscreen', 80)
const fs120 = shoot('/fullscreen', 120)

console.log('\n── /model (responsive: stack < 110 cols · footer + rows intact, not shrink-wrapped) ──')
expect('@80  footer tail intact on one line (stacked, no wrap)', /↵ switch · esc close/.test(model80))
expect('@120 footer tail intact on one line (side-by-side, no wrap)', /↵ switch · esc close/.test(model120))
expect('@80  longest rail row intact (not shrink-wrapped)', /Scribe — 2× op… ○ switch\s+1M ctx/.test(model80))
expect('@80  the model rail header renders', /\d+ AVAILABLE/.test(model80))

console.log('\n── /fullscreen (WI3: drop right rail <100 · WI2: no duplicate fleet) ──')
expect('@120 RIGHT telemetry rail PRESENT (usage/trace panel)', /usage/.test(fs120))
expect('@80  RIGHT telemetry rail DROPPED (no usage panel)', !/usage/.test(fs80))
expect('@80  center fleet chat honest-empty renders', /no teammates yet/.test(fs80))
expect('@120 center fleet chat honest-empty renders', /no teammates yet/.test(fs120))

console.log('\n── /fullscreen onSend wired (WI1 source smoke) ──')
const fsSrc = readFileSync(join(REPO, 'src', 'commands', 'fullscreen', 'fullscreen.tsx'), 'utf-8')
expect('fullscreen passes onSend to MercuryFleetChat', /onSend=\{handleSend\}/.test(fsSrc))
expect('handleSend delivers via writeToMailbox (the SendMessage transport)', /writeToMailbox\(/.test(fsSrc))

console.log('\nHTML written to /tmp/hermes-surface-{model,fullscreen}-{80,120}.html')
console.log(failures === 0 ? '\n✅ HERMES-SURFACES RENDER-VERIFY PASS' : `\n❌ ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
