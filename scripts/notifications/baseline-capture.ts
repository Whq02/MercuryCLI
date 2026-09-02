#!/usr/bin/env bun
// ============================================================================
//  scripts/notifications/baseline-capture.ts —.5: the
//  pre-implementation baselines the budgets compare against,
//  captured from the SHIPPED dist/mercury.mjs in the hermetic PTY arena
//  (scripts/streaming/artifactArena.ts — the INTERVIEW baseline pattern).
//
//  NOT a pool prover — a deliberate capture tool. Artifacts land in
//  scripts/notifications/baselines/<name>.json and are committed as the
//  record. Candidate trees are compared against these captures at
//: boot-to-paint, input-echo distribution, resize churn,
//  idle output activity, terminal-mode byte census.
//
//  Machine profile: this capture names the capable-workstation profile (the
//  dev Mac). The low-resource Windows and hosted-runner profiles ride the
//  four dispatch-only lanes at — recorded partition, not a gap.
//  Five-session baselines cannot exist on this tree (the surface is what
//  builds); the Off-path boot IS the baseline envelope.
//
//  Run:  ~/.bun/bin/bun run scripts/notifications/baseline-capture.ts
//  Requires the prebuilt dist (bun run build.ts).
// ============================================================================
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { cpus, platform, release, totalmem } from 'node:os'
import { join } from 'node:path'
import {
  DIST,
  firstOutputTs,
  grabScreens,
  pct,
  requireDist,
  runArtifactArena,
  visibleText,
  type ArenaRun,
} from '../streaming/artifactArena.ts'

requireDist()
const OUT = join(import.meta.dir, 'baselines')
mkdirSync(OUT, { recursive: true })

// ── shared identity + machine profile ───────────────────────────────────────

// the src tree object: content-addressed, so the same sources name the same object in any clone
const SRC_TREE = execSync('git rev-parse HEAD:src', { encoding: 'utf8' }).trim()
const DIRTY = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0
const distBytes = statSync(DIST).size
const distSha = createHash('sha256').update(readFileSync(DIST)).digest('hex')

const MACHINE = {
  profile: 'capable-workstation (dev Mac)',
  platform: platform(),
  osRelease: release(),
  cpu: cpus()[0]?.model ?? 'unknown',
  cores: cpus().length,
  totalMemGiB: Math.round(totalmem() / 2 ** 30),
}

interface DriveEntry {
  ts?: number
  sent?: number
  atMs?: number
  b64?: string
}

function driveEntries(run: ArenaRun): DriveEntry[] {
  const out: DriveEntry[] = []
  for (const line of readFileSync(run.paths.drive, 'utf8').split('\n')) {
    if (!line) continue
    try {
      out.push(JSON.parse(line) as DriveEntry)
    } catch {
      // torn tail line — capture tool tolerance
    }
  }
  return out
}

function decodeBytes(entries: DriveEntry[]): { total: number; chunks: { ts: number; bytes: number; text: string }[] } {
  const chunks: { ts: number; bytes: number; text: string }[] = []
  let total = 0
  for (const e of entries) {
    if (typeof e.ts !== 'number' || typeof e.b64 !== 'string') continue
    const buf = Buffer.from(e.b64, 'base64')
    total += buf.length
    chunks.push({ ts: e.ts, bytes: buf.length, text: buf.toString('latin1') })
  }
  return { total, chunks }
}

/** Census of terminal-mode / ground control sequences — the route-silence
 *  comparison base (proves ZERO of these per route on the candidate). */
function modeByteCensus(text: string): Record<string, number> {
  const PATTERNS: Record<string, RegExp> = {
    'alt-screen (1049)': /\x1b\[\?1049[hl]/g,
    'focus-events (1004)': /\x1b\[\?1004[hl]/g,
    'bracketed-paste (2004)': /\x1b\[\?2004[hl]/g,
    'mouse (1000-1006)': /\x1b\[\?100[0-6][hl]/g,
    'alt-scroll (1007)': /\x1b\[\?1007[hl]/g,
    'sync-update (2026)': /\x1b\[\?2026[hl]/g,
    'kitty-kbd (>u)': /\x1b\[[<>=]\d*u/g,
    'ground OSC 11': /\x1b\]11;/g,
    'title OSC 0/2': /\x1b\][02];/g,
    'cursor show/hide (25)': /\x1b\[\?25[hl]/g,
  }
  const census: Record<string, number> = {}
  for (const [name, re] of Object.entries(PATTERNS)) {
    census[name] = (text.match(re) ?? []).length
  }
  return census
}

function write(name: string, data: Record<string, unknown>): void {
  const path = join(OUT, `${name}.json`)
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        baseline: name,
        capturedAt: new Date().toISOString(),
        tree: { source: SRC_TREE, dirty: DIRTY },
        dist: { bytes: distBytes, sha256: distSha },
        machine: MACHINE,
        ...data,
      },
      null,
      1,
    )}\n`,
  )
  console.log(`  wrote ${path}`)
}

// ── b01: plain interactive boot + idle window ───────────────────────────────

console.log('── b01-plain-boot-idle (142×38, 14 s) ──')
{
  const spawnedAt = Date.now()
  const run = await runArtifactArena({
    turns: [],
    sends: [],
    seconds: 14,
    cols: 142,
    rows: 38,
    probe: true,
    keep: true,
  })
  try {
    const base = firstOutputTs(run)
    const entries = driveEntries(run)
    const { total, chunks } = decodeBytes(entries)
    const lastTs = chunks.length ? chunks[chunks.length - 1]!.ts : base
    // Idle window: the final 4 s of the run — the REPL sits at its prompt.
    const idleStart = lastTs - 4000
    const idle = chunks.filter(c => c.ts >= idleStart)
    const screens = grabScreens(run, 142, 38, [3000, 8000, -1])
    const finalRows = screens[screens.length - 1]?.rows ?? []
    const allText = chunks.map(c => c.text).join('')
    write('b01-plain-boot-idle', {
      note: 'cold interactive boot of the shipped dist, no input — the Off-path envelope',
      arenaStartToFirstOutputMs: base - spawnedAt,
      outputTotal: { bytes: total, chunks: chunks.length },
      idleWindow4s: {
        chunks: idle.length,
        bytes: idle.reduce((a, c) => a + c.bytes, 0),
      },
      probeFrames: run.probe?.frames ?? null,
      modeByteCensus: modeByteCensus(allText),
      finalScreenSample: finalRows.slice(0, 6).map(visibleText),
      screensCapturedAtMs: [3000, 8000, -1],
    })
  } finally {
    run.cleanup()
  }
}

// ── b02: input-echo latency distribution ────────────────────────────────────

console.log('── b02-input-echo (20 keystrokes @250 ms) ──')
{
  const KEYS = 20
  const sends: string[] = []
  for (let i = 0; i < KEYS; i++) sends.push(`${6000 + i * 250}:x`)
  const run = await runArtifactArena({
    turns: [],
    sends,
    seconds: 13,
    cols: 142,
    rows: 38,
    keep: true,
  })
  try {
    const entries = driveEntries(run)
    const sendTs = entries.filter(e => typeof e.sent === 'number').map(e => e.sent as number)
    const outTs = entries.filter(o => typeof o.ts === 'number').map(o => o.ts as number)
    const echoes: number[] = []
    for (const s of sendTs) {
      const first = outTs.find(t => t >= s)
      if (first != null) echoes.push(first - s)
    }
    write('b02-input-echo', {
      note: 'composer keystroke → first PTY output chunk, 20 samples at 250 ms spacing',
      samples: echoes.length,
      p50Ms: pct(echoes, 50),
      p95Ms: pct(echoes, 95),
      maxMs: echoes.length ? Math.max(...echoes) : null,
      distribution: echoes,
    })
  } finally {
    run.cleanup()
  }
}

// ── b03: resize churn ───────────────────────────────────────────────────────

console.log('── b03-resize-churn (142×38 → 100×30 → 142×38) ──')
{
  const run = await runArtifactArena({
    turns: [],
    sends: [],
    seconds: 12,
    cols: 142,
    rows: 38,
    resizes: ['7000:100:30', '9000:142:38'],
    keep: true,
  })
  try {
    const entries = driveEntries(run)
    const { chunks } = decodeBytes(entries)
    const base = firstOutputTs(run)
    const windowBytes = (fromMs: number, ms: number): number =>
      chunks.filter(c => c.ts >= base + fromMs && c.ts < base + fromMs + ms).reduce((a, c) => a + c.bytes, 0)
    write('b03-resize-churn', {
      note: 'bytes repainted within 1.5 s of each TIOCSWINSZ+SIGWINCH',
      resize1shrinkBytes: windowBytes(7000, 1500),
      resize2growBytes: windowBytes(9000, 1500),
      steadyPre7sBytes: windowBytes(5000, 1500),
    })
  } finally {
    run.cleanup()
  }
}

console.log('baseline capture complete')
