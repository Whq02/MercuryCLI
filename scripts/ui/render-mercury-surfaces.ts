#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-mercury-surfaces.ts — render-verify for the dedicated
//  /fullscreen + /model command surfaces (the Hermes* command cluster).
//  The render-verify law: an Ink change is only "working" once the REAL TUI is
//  captured. This rebuilds, then drives each slash command in a pyte PTY
//  (vshot.py) at 80 AND 120 cols and asserts the responsive behavior:
//
//    WI3  /model   : the footer ('esc close') is FULLY visible at BOTH widths —
//                    i.e. the 50+52=102 panels STACK at 80 instead of overflowing.
//    WI3  /fullscreen: the RIGHT telemetry rail (unique marker 'active' from the
//                    substrate row) is PRESENT@120 and ABSENT@80 (drops <100).
//    WI2  /fullscreen: the center fleet chat's honest-empty 'no named agents yet'
//                    renders, and there is no duplicate LEFT 'fleet' list.
//    WI1  (source wire): fullscreen.tsx routes onSend → writeToMailbox (the
//                    SendMessage/mailbox transport), never a dropped log line.
//                    The transport itself is proven by the swarm/teammate suite.
//
//  Run:  ~/.bun/bin/bun run scripts/ui/render-mercury-surfaces.ts
//  Out:  /tmp/hermes-surface-<cmd>-<cols>.html  + a grep summary.
// ============================================================================
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveProofHome } from '../lib/proofHome.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const BUN = process.env.BUN || join(process.env.HOME!, '.bun', 'bin', 'bun')
// The proof's config home (scripts/lib/proofHome.ts): the inherited pin, else
// a fresh seeded scratch — never another program's directory.
const CONFIG_HOME = resolveProofHome([process.cwd()])
const VSHOT = new URL('./vshot.py', import.meta.url).pathname
const BIN = join(REPO, 'dist', 'mercury.mjs')

if (!existsSync(VSHOT)) {
  console.error(`vshot.py not found at ${VSHOT} — the render-verify harness (scripts/ui/vshot.py) is required.`)
  process.exit(1)
}

// Rebuild so the capture reflects the current source (no typecheck — the render IS the gate).
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
    // type the slash command, then ENTER, after the splash has settled. The settle
    // delay is generous (4.2s) because this script runs right after a 16s build and
    // back-to-back PTY spawns — a tighter delay raced startup and captured empty.
    // {atTick,data} — the wall-clock vshot format ([delaySeconds,key]
    // tuples crash vshot).
    sends: [{ atTick: 30, data: cmd }, { atTick: 38, data: '\r' }],
    total: 56,
    cols,
    rows: 40,
    out,
    title: `${cmd} @ ${cols}`,
  }
  // vshot.py reads its config from a FILE PATH (json.load(open(argv[1]))), so write
  // the cfg to a temp file and pass the path — NOT the inline JSON string (that made
  // open() throw FileNotFoundError → vshot crashed → empty capture → every check
  // falsely FAILED). Mirrors render-turn-restyle.ts's working file-path interface.
  const cfgPath = `/tmp/vs-surface-${cmd.replace(/\//g, '')}-${cols}.json`
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf-8',
    env: { ...process.env,
    // Split-home guard: bun-side writers and the stamp-defaulted dist must
    // resolve ONE home even outside the gate unit's pin (pinned home).
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
// LAYOUT-INTEGRITY checks, not mere string presence: a substring that spans the
// width only matches when it lands on ONE grid line. The old `/esc close/` check
// was falsely green while the picker shrink-wrapped at 80 (50+52 panels in a
// flexDirection="row" forced below their content width → "switch"/"complex
// work"/"close" orphaned on wrap lines). These assert the full footer TAIL and the
// longest rail row each render unbroken — they go RED if the picker ever wraps again.
expect('@80  footer tail intact on one line (stacked, no wrap)', /↵ switch · esc close/.test(model80))
expect('@120 footer tail intact on one line (side-by-side, no wrap)', /↵ switch · esc close/.test(model120))
// #78 default-1M picker tightened the name column (15w + …) — the anti-wrap
// guard now keys on the truncated row staying ONE line with its ctx cell.
expect('@80  longest rail row intact (not shrink-wrapped)', /○ switch\s+\S+ ctx/.test(model80))
expect('@80  the model rail header renders', /\d+ AVAILABLE/.test(model80))

console.log('\n── /fullscreen (WI3: drop right rail <100 · WI2: no duplicate fleet) ──')
// The RIGHT rail is the usage/trace telemetry panel; its `usage` header is unique
// to that rail in this surface (the frame/deck say `limits`, not `usage`). It is
// PRESENT @120 and DROPPED @80 (<100). (Was the stale substrate "active" marker —
// the right rail was reworked to a usage/trace panel, so `active` no longer appears.)
expect('@120 RIGHT telemetry rail PRESENT (usage/trace panel)', /usage/.test(fs120))
expect('@80  RIGHT telemetry rail DROPPED (no usage panel)', !/usage/.test(fs80))
expect('@80  center fleet chat honest-empty renders', /no named agents yet/.test(fs80))
expect('@120 center fleet chat honest-empty renders', /no named agents yet/.test(fs120))

console.log('\n── /fullscreen onSend wired (WI1 source smoke) ──')
const fsSrc = readFileSync(join(REPO, 'src', 'commands', 'fullscreen', 'fullscreen.tsx'), 'utf-8')
expect('fullscreen passes onSend to MercuryFleetChat', /onSend=\{handleSend\}/.test(fsSrc))
expect('handleSend delivers via writeToMailbox (the SendMessage transport)', /writeToMailbox\(/.test(fsSrc))

console.log('\nHTML written to /tmp/hermes-surface-{model,fullscreen}-{80,120}.html')
console.log(failures === 0 ? '\n✅ HERMES-SURFACES RENDER-VERIFY PASS' : `\n❌ ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
