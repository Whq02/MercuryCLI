#!/usr/bin/env bun
// ============================================================================
//  scripts/render-migration/prove-engine-cockpit-smoke.ts — the engine-
//  mounted cockpit, LIVE: the real built artifact in a real PTY with
//  MERCURY_RENDER_ENGINE=1 and every tripwire armed (MERCURY_ENGINE_ASSERT=1
//  — a refold or a ledger disagreement THROWS inside the product), turn
//  receipts ON (the ledger's boundaries), two scripted turns settling.
//
//  C1  the cockpit boots, takes two prompts, settles both, and returns to
//      the composer alive (no tripwire fired — the process would have died).
//  C2  THE COCKPIT DOUBLES CENSUS (sheet bug #1, measured on the screen):
//      each settled reply's text appears EXACTLY ONCE on the final screen —
//      counted on the pyte grid, engine ON; the OFF leg counted beside it.
//  C3  the engine's door is the writer: the raw capture shows the frame
//      brackets and mode bytes the classic path emits, byte-parseable
//      (a strict VT walk finds zero torn sequences).
//
//  Run: ~/.bun/bin/bun run scripts/render-migration/prove-engine-cockpit-smoke.ts [--skip-build]
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
const OUT = mkdtempSync(join(tmpdir(), 'engine-cockpit-smoke-'))

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

console.log('============================================================')
console.log(' engine-mounted cockpit smoke — live, tripwires armed')
console.log(`  out → ${OUT}`)
console.log('============================================================')

if (!process.argv.includes('--skip-build')) {
  const build = spawnSync(process.execPath, ['run', 'build.ts'], { cwd: REPO, encoding: 'utf8', timeout: 600_000 })
  check('dist rebuilt from this tree (stale-dist guard)', build.status === 0, (build.stderr ?? '').slice(-300))
}
if (!existsSync(BIN)) {
  check('dist/mercury.mjs exists', false)
  process.exit(1)
}
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')

const FIX = join(OUT, 'fixture-cwd')
mkdirSync(FIX, { recursive: true })
writeFileSync(join(FIX, 'README.md'), '# engine cockpit smoke fixture\n')

type Grid = Array<Array<{ c: string }>>
function drive(leg: 'off' | 'on'): { ok: boolean; detail: string; final: string[]; raw: Buffer } {
  const home = join(OUT, `home-${leg}`)
  process.env.ANTHROPIC_API_KEY = 'proof-key-scripted-stream'
  seedFirstRun(home, [FIX, realpathSync(FIX)])
  const gridPath = join(OUT, `grid-${leg}.json`)
  const teePath = join(OUT, `raw-${leg}.tee`)
  const cfgPath = join(OUT, `vshot-${leg}.json`)
  writeFileSync(
    cfgPath,
    JSON.stringify({
      argv: ['node', BIN],
      cwd: FIX,
      cols: 120,
      rows: 40,
      total: 200,
      sends: [
        // THE LANDING RULE: a
        // bare boot lands on the Boot face — ↵ on New Session enters the
        // chat; the '❯' gate below then matches the composer, not the face.
        { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
        // '❯' matched the FACE's own rows too, so the first prompt fired
        // into the birth transition and was lost — the chat hint is the
        // unambiguous post-entry needle.
        { atTick: 60, minTick: 5, awaitText: '? for shortcuts', awaitSettleTicks: 3, data: 'first smoke prompt\r' },
        { atTick: 130, minTick: 20, awaitText: 'stream settled', awaitSettleTicks: 4, data: 'second smoke prompt\r' },
      ],
      out: gridPath,
    }),
  )
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // The credential door sits upstream of the scripted-stream seam: a
    // keyless world refuses the dispatch before the script plays. The
    // scene pins its own proof key (no real call is possible).
    ANTHROPIC_API_KEY: 'proof-key-scripted-stream',
    MERCURY_SCRIPTED_STREAM: 'slow-text',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_TABULA_MINERVA: '0',
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(OUT, `daemon-${leg}`),
    MERCURY_TEAMS_DIR: join(OUT, `teams-${leg}`),
    MERCURY_TABULA_DIR: join(OUT, `tabula-${leg}`),
    MERCURY_HOME: join(OUT, `mhome-${leg}`),
    VSHOT_TEE: teePath,
    VISUAL: '',
    EDITOR: '',
  }
  delete env.MERCURY_RENDER_ENGINE
  delete env.MERCURY_ENGINE_ASSERT
  delete env.MERCURY_TURN_RECEIPT // receipts ON — the ledger's boundaries
  if (leg === 'on') {
    env.MERCURY_RENDER_ENGINE = '1'
    env.MERCURY_ENGINE_ASSERT = '1'
  }
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(240_000), env })
  if (res.status !== 0) return { ok: false, detail: (res.stderr ?? '').slice(-400), final: [], raw: Buffer.alloc(0) }
  const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: Grid; endReason?: string }
  const final = payload.grid.map(r => r.map(c => c.c).join(''))
  // The tee is a sequence of (>II tick,len) records; splice the raw bytes.
  const tee = existsSync(teePath) ? readFileSync(teePath) : Buffer.alloc(0)
  const chunks: Buffer[] = []
  let off = 0
  while (off + 8 <= tee.length) {
    const n = tee.readUInt32BE(off + 4)
    off += 8
    chunks.push(tee.subarray(off, off + n))
    off += n
  }
  return { ok: true, detail: payload.endReason ?? '', final, raw: Buffer.concat(chunks) }
}

/** Strict VT walk: every ESC-introduced sequence must complete inside the
 *  stream (CSI final byte in 0x40–0x7E; OSC/DCS/APC terminated by ST or
 *  BEL). Returns the count of torn sequences. */
function tornSequences(raw: Buffer): number {
  let torn = 0
  let i = 0
  const n = raw.length
  while (i < n) {
    if (raw[i] !== 0x1b) {
      i++
      continue
    }
    const next = raw[i + 1]
    if (next === undefined) {
      torn++
      break
    }
    if (next === 0x5b) {
      // CSI: params/intermediates 0x20–0x3F, final 0x40–0x7E
      let j = i + 2
      while (j < n && raw[j]! >= 0x20 && raw[j]! <= 0x3f) j++
      if (j >= n || raw[j]! < 0x40 || raw[j]! > 0x7e) torn++
      i = j + 1
      continue
    }
    if (next === 0x5d || next === 0x50 || next === 0x5f) {
      // OSC / DCS / APC: to BEL or ESC \
      let j = i + 2
      let closed = false
      while (j < n) {
        if (raw[j] === 0x07) {
          closed = true
          break
        }
        if (raw[j] === 0x1b && raw[j + 1] === 0x5c) {
          closed = true
          j++
          break
        }
        j++
      }
      if (!closed) torn++
      i = j + 1
      continue
    }
    // Two-byte escapes (ESC 7, ESC 8, ESC =, ESC >, ESC c…) and charset
    // designations (ESC ( B): one or two following bytes.
    if (next === 0x28 || next === 0x29) {
      if (i + 2 >= n) torn++
      i += 3
      continue
    }
    i += 2
  }
  return torn
}

const countOnGrid = (final: string[], needle: string): number => final.join('\n').split(needle).length - 1

const legs: Record<string, ReturnType<typeof drive>> = {}
for (const leg of ['off', 'on'] as const) {
  section(`leg ${leg.toUpperCase()}`)
  const r = drive(leg)
  legs[leg] = r
  check(`${leg}: the capture ran (${r.detail})`, r.ok, r.detail)
  if (!r.ok) continue
  const flat = r.final.join('\n')
  check(`${leg}: C1 the cockpit is alive at the end — the composer is back`, r.final.some(l => l.includes('❯')), r.final.slice(-6).join('\n'))
  check(`${leg}: C1 both prompts landed in the transcript`, flat.includes('first smoke prompt') && flat.includes('second smoke prompt'), flat.slice(0, 600))
  const settledCount = countOnGrid(r.final, 'Scripted stream settled')
  check(`${leg}: C2 the settled reply text appears EXACTLY twice on screen (two turns, one copy each)`, settledCount === 2, `count=${settledCount}`)
  // The LANES RAIL lawfully lists the session's prompts as its own rows
  // (the concourse estate's landed truth — full-grid counts read 2 for
  // every prompt), so the duplication tooth counts INSIDE the transcript
  // pane only: right of the rail band, each prompt paints exactly once.
  const paneOnly = r.final.map(l => l.slice(24))
  check(`${leg}: C2 each prompt appears exactly once INSIDE the transcript pane (the rail's prompt rows are its own lawful estate)`, countOnGrid(paneOnly, 'first smoke prompt') === 1 && countOnGrid(paneOnly, 'second smoke prompt') === 1, `pane first=${countOnGrid(paneOnly, 'first smoke prompt')} second=${countOnGrid(paneOnly, 'second smoke prompt')}`)
  const torn = tornSequences(r.raw)
  check(`${leg}: C3 the raw byte stream has zero torn escape sequences (${r.raw.length} bytes)`, r.raw.length > 0 && torn === 0, `torn=${torn}`)
  if (leg === 'on') {
    check('on: C3 the alt-screen entry left through the door', r.raw.includes('\x1b[?1049h'))
  }
}

// C3, the bracket law across the legs: the door carries what the capability
// latch composes — it neither invents nor drops synchronized-output
// brackets. Under this harness (vshot answers no capability query) the latch
// stays off on BOTH legs and zero 2026 bytes leave either way; a harness
// that answers the probe would show brackets on both. Presence must agree.
if (legs.off?.ok && legs.on?.ok) {
  const count = (raw: Buffer, needle: string): number => raw.toString('latin1').split(needle).length - 1
  const offOpen = count(legs.off.raw, '\x1b[?2026h')
  const onOpen = count(legs.on.raw, '\x1b[?2026h')
  const offClose = count(legs.off.raw, '\x1b[?2026l')
  const onClose = count(legs.on.raw, '\x1b[?2026l')
  check(
    'C3 synchronized-output bracket presence agrees ON vs OFF (the door carries the latch’s brackets, never its own)',
    (offOpen > 0) === (onOpen > 0) && (offClose > 0) === (onClose > 0),
    `off ${offOpen}/${offClose} · on ${onOpen}/${onClose}`,
  )
  check('C3 brackets balance on the ON leg (every open has its close)', onOpen === onClose, `${onOpen} vs ${onClose}`)
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
console.log(`captures kept at ${OUT}`)
process.exit(failures === 0 ? 0 : 1)
