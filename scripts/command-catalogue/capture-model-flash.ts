// capture-model-flash — the L-7 evidence harness (§6, solo-run — NOT a
// gate member; it drives the BUILT artifact and takes ~40s of PTY wall-clock).
//
// The lead: an operator report of a white flash around /model. The defect hunt's two
// raw-PTY captures found zero flash bytes; CANON kept the lead OPEN pending a
// current matrix. This harness runs that matrix: theme ∈ {dark, light} ×
// size ∈ {80×24, 120×40}, each journey opening AND re-opening /model (first
// open + repeated open/close), capturing EVERY raw byte the child emits
// (VSHOT_TEE), then scanning all bytes AFTER the first keystroke for the
// flash-capable classes:
//   OSC 11 (ground set) · OSC 111 (ground reset) · ED2/ED3 (clear screen) ·
//   RIS (full reset) · alt-screen toggles (1049/47 h/l)
// Boot-window occurrences (alt enter + the one OASIS OSC 11) are EXPECTED and
// reported separately. A clean matrix = the lead closes UNREPRODUCED with
// this file as the exact command receipt.
//
// Run: ~/.bun/bin/bun run scripts/command-catalogue/capture-model-flash.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const repo = path.resolve(import.meta.dir, '../..')
const dist = path.join(repo, 'dist/mercury.mjs')
if (!existsSync(dist)) {
  console.error('capture-model-flash: dist/mercury.mjs missing — run the build first')
  process.exit(1)
}

// Hermetic home BEFORE renderScenarios loads (its CONFIG_HOME is a module-load
// snapshot) — the F6 ambient-state law.
const RUN_HOME = path.join(tmpdir(), `mercury-l7-${process.pid}`)
mkdirSync(RUN_HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = RUN_HOME

const scenarios = await import('../../scripts/ui/renderScenarios.js')
const { writeSyntheticSession, SID, RUNTIME_CWD } = scenarios

// An unapproved env key leaves the booted REPL in a consent state that
// silently consumes keystrokes — seed the approval record for whatever key
// the child sees (the generate-visual-baseline.ts seed shape).
const PROBE_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-verity-shape-probe'

function seedHome(theme: string): void {
  // getGlobalMercuryFile resolves `<home>/.mercury.json` — the one spelling
  // the product reads on a fresh home.
  writeFileSync(
    path.join(RUN_HOME, '.mercury.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme,
      projects: { [repo]: { hasTrustDialogAccepted: true } },
      customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
    }),
  )
  writeFileSync(path.join(RUN_HOME, 'settings.json'), JSON.stringify({}))
}

type Case = { theme: string; cols: number; rows: number }
const MATRIX: Case[] = [
  { theme: 'dark', cols: 80, rows: 24 },
  { theme: 'dark', cols: 120, rows: 40 },
  { theme: 'light', cols: 80, rows: 24 },
  { theme: 'light', cols: 120, rows: 40 },
]

// The journey: boot → /model ↵ (first open) → esc → /model ↵ (repeat) — the
// capture ENDS on the re-opened picker so the final grid PROVES the journey
// actually exercised /model (a swallowed-keys run would read vacuously
// clean). The first keystroke gates on the bracketed-paste arm (input
// readiness is DECLARED, never guessed); the rest ride relative scheduling.
const SENDS = [
  { atTick: 55, minTick: 5, awaitRaw: '\x1b[?2004h', data: '/model' },
  { afterPrevTicks: 6, data: '\r' },
  { afterPrevTicks: 12, data: '\x1b' },
  { afterPrevTicks: 8, data: '/model' },
  { afterPrevTicks: 6, data: '\r' },
]
const TOTAL = 110

const FLASH_CLASSES: Array<[string, RegExp]> = [
  ['OSC-11 ground set', /\x1b\]11;/g],
  ['OSC-111 ground reset', /\x1b\]111/g],
  ['ED2 clear-screen', /\x1b\[2J/g],
  ['ED3 clear-scrollback', /\x1b\[3J/g],
  ['RIS full-reset', /\x1bc/g],
  ['alt-screen 1049 toggle', /\x1b\[\?1049[hl]/g],
  ['alt-screen 47 toggle', /\x1b\[\?0?47[hl]/g],
]

function analyzeTee(teePath: string, firstSendTick: number): { boot: string[]; post: string[] } {
  const buf = readFileSync(teePath)
  let off = 0
  const bootChunks: Buffer[] = []
  const postChunks: Buffer[] = []
  while (off + 8 <= buf.length) {
    const tick = buf.readUInt32BE(off)
    const len = buf.readUInt32BE(off + 4)
    off += 8
    const data = buf.subarray(off, off + len)
    off += len
    ;(tick < firstSendTick ? bootChunks : postChunks).push(data)
  }
  const scan = (chunks: Buffer[]): string[] => {
    const joined = Buffer.concat(chunks).toString('latin1')
    const found: string[] = []
    for (const [label, re] of FLASH_CLASSES) {
      const n = (joined.match(re) ?? []).length
      if (n > 0) found.push(`${label} ×${n}`)
    }
    return found
  }
  return { boot: scan(bootChunks), post: scan(postChunks) }
}

let reproduced = false
console.log('L-7 /model flash matrix — raw-byte scan of the BUILT artifact')
console.log(`artifact: ${dist}`)

for (const c of MATRIX) {
  seedHome(c.theme)
  writeSyntheticSession('short')
  const tee = path.join(RUN_HOME, `tee-${c.theme}-${c.cols}x${c.rows}.bin`)
  const cfgPath = path.join(RUN_HOME, `cfg-${c.theme}-${c.cols}.json`)
  const out = path.join(RUN_HOME, `grid-${c.theme}-${c.cols}.json`)
  writeFileSync(
    cfgPath,
    JSON.stringify({
      argv: ['node', dist, '--resume', SID],
      sends: SENDS,
      total: TOTAL,
      cols: c.cols,
      rows: c.rows,
      out,
    }),
  )
  const res = spawnSync('/usr/bin/python3', [path.join(repo, 'scripts/ui/vshot.py'), cfgPath], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(120000),
    cwd: RUNTIME_CWD,
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: RUN_HOME,
      ANTHROPIC_API_KEY: PROBE_KEY,
      VSHOT_TEE: tee,
    },
  })
  if (res.status !== 0) {
    console.error(`  [${c.theme} ${c.cols}×${c.rows}] capture FAILED: ${res.stderr?.slice(0, 300)}`)
    reproduced = true // a failed capture is not a clean pass — surface loudly
    continue
  }
  // The analysis boundary = the ACTUAL first-send tick (awaitRaw may fire
  // before the hard deadline), from vshot's own receipts. The final grid must
  // show the RE-OPENED picker — the proof the journey exercised /model.
  const payload = JSON.parse(readFileSync(out, 'utf8')) as {
    sendReceipts?: Array<{ atTick: number }>
    grid: Array<Array<{ c: string }>>
  }
  const firstSend = payload.sendReceipts?.[0]?.atTick
  if (firstSend === undefined || (payload.sendReceipts?.length ?? 0) < SENDS.length) {
    console.error(`  [${c.theme} ${c.cols}×${c.rows}] sends incomplete (${payload.sendReceipts?.length ?? 0}/${SENDS.length}) — not a clean pass`)
    reproduced = true
    continue
  }
  const finalText = payload.grid.map(row => row.map(cell => cell.c).join('')).join('\n')
  if (!finalText.includes('CHOOSE A MODEL')) {
    console.error(`  [${c.theme} ${c.cols}×${c.rows}] the picker never re-opened — a vacuous capture, not a clean pass`)
    reproduced = true
    continue
  }
  const { boot, post } = analyzeTee(tee, firstSend)
  const verdict = post.length === 0 ? 'CLEAN' : `FLASH BYTES: ${post.join(' · ')}`
  if (post.length > 0) reproduced = true
  console.log(`  [${c.theme} ${c.cols}×${c.rows}] post-boot (send@${firstSend}): ${verdict}   (boot-window, expected: ${boot.join(' · ') || 'none'})`)
}

console.log(
  reproduced
    ? '\nL-7 verdict: REPRODUCED — flash-class bytes after boot; investigate the emitting frame'
    : '\nL-7 verdict: UNREPRODUCED — zero flash-class bytes after boot across the full matrix',
)
process.exit(reproduced ? 1 : 0)
