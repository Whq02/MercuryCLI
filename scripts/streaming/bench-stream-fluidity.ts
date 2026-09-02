#!/usr/bin/env bun
// ============================================================================
//  scripts/streaming/bench-stream-fluidity.ts — the in-process fluidity bench
// NOT in the gate — operator-run; results are
//  recorded beside the suite.
//
//  Method (the measure-render-traffic pattern): a child mounts the REAL
//  streaming surface under a real Ink render inside ptyrun.py's PTY
//  (isTTY=true ⇒ production 16ms throttle + fd writeAllSync), driven by the
//  deterministic fixtures in fixtures.ts through the REAL fan-out
//  (handleMessageFromStream). INK_WRITE_TEE_FULL records every terminal
//  write with ts + full content; the child records when each sentinel token
//  was EMITTED. Parent metrics per scene:
//
//    writes/s · bytes/s            — terminal load during the stream window
//    rootCommits                   — how often the ROOT tree re-rendered
//    sentinel p50/p95/max ms       — emit → first terminal write containing
//                                    the token (defect A, quantified)
//    firstOutputMs                 — first delta emit → first write with text
//    finalTextComplete             — the full text reached the terminal
//
//  The child mounts the streaming wiring behind scripts/streaming/streamHarness.tsx
//  which replicates REPL.tsx's CURRENT contract (per-line visibility) — when
//  S2 lands, the harness switches to the new tail store and the SAME bench
//  measures the after. The harness is the measured subject; keep it faithful.
//
//  Run:  ~/.bun/bin/bun run scripts/streaming/bench-stream-fluidity.ts [scene…]
//        MEASURE_JSON=/path/out.json for machine-readable results.
// ============================================================================

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIN, FIXTURE_NAMES } from './fixtures.ts'

const SELF = fileURLToPath(import.meta.url)
const HERE = dirname(SELF)
const BUN = process.execPath

// ── child ────────────────────────────────────────────────────────────────
if (process.env.MEASURE_CHILD) {
  const { runStreamScene } = await import('./streamHarness.tsx')
  await runStreamScene(process.env.MEASURE_SCENE!, process.env.MEASURE_OUT!)
  // runStreamScene exits the process itself after flushing its summary.
} else {
  // ── parent ───────────────────────────────────────────────────────────────
  const scenes = process.argv.slice(2).filter(a => !a.startsWith('-'))
  const chosen = scenes.length > 0 ? scenes : [...FIXTURE_NAMES, 'typing-under-stream']

  // typing-under-stream: 8 distinctive glyphs injected via ptydrive.py while
  // fast-tiny streams; echo latency = send ts → first write showing the glyph.
  const TYPE_GLYPHS = ['Ξ', 'Ψ', 'Φ', 'Ω', 'Λ', 'Θ', 'Π', 'Σ']
  const TYPE_SENDS = TYPE_GLYPHS.map((g, i) => ({ atMs: 1200 + i * 400, text: g }))

  type SceneResult = {
    scene: string
    durationMs: number
    writes: number
    writesPerSec: number
    bytesPerSec: number
    rootCommits: number
    tailCommits: number
    deltas: number
    sentinelMs: { p50: number; p95: number; max: number; n: number; misses: number }
    firstOutputMs: number
    finalTextComplete: boolean
    echoMs?: { p50: number; p95: number; max: number; n: number; misses: number }
  }
  const results: SceneResult[] = []

  const pct = (xs: number[], p: number): number => {
    if (xs.length === 0) return -1
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!
  }

  // The differ interleaves CSI cursor moves + SGR mid-row and hard-wraps rows,
  // so a sentinel's glyphs are rarely contiguous in the raw write. Normalize:
  // strip every escape sequence and ALL whitespace — a token split by a wrap
  // or a skipped-cell cursor move reassembles; visibility matching runs on
  // this corpus. (Cells are never reordered within a write, so glyph order
  // survives normalization.)
  const ESC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?<=>]*[A-Za-z@`~]|\x1b[()][0-9A-Za-z]|\x1b[A-Za-z=><]/g
  const visible = (s: string): string => s.replace(ESC_RE, '').replace(/[\s─-╿]+/g, '')

  for (const scene of chosen) {
    const dir = mkdtempSync(join(tmpdir(), `flux-bench-${scene}-`))
    const tee = join(dir, 'tee.jsonl')
    const out = join(dir, 'child.json')
    // Scene stream time + boot headroom; the runner hard-kills at the deadline.
    const seconds = 16
    const isTyping = scene === 'typing-under-stream'
    const drive = join(dir, 'drive.jsonl')
    const runnerArgs = isTyping
      ? [
          join(HERE, 'ptydrive.py'),
          '--cols', '120', '--rows', '40', '--seconds', String(seconds), '--out', drive,
          ...TYPE_SENDS.flatMap(s => ['--send', `${s.atMs}:${s.text}`]),
          '--', BUN, 'run', SELF, scene,
        ]
      : [
          join(HERE, '..', 'ui', 'ptyrun.py'),
          '--cols', '120', '--rows', '40', '--seconds', String(seconds),
          '--', BUN, 'run', SELF, scene,
        ]
    const res = spawnSync(
      '/usr/bin/python3',
      runnerArgs,
      {
        encoding: 'utf8',
        timeout: (seconds + 20) * 1000,
        env: {
          ...process.env,
          MEASURE_CHILD: '1',
          MEASURE_SCENE: scene,
          MEASURE_OUT: out,
          INK_WRITE_TEE: tee,
          INK_WRITE_TEE_FULL: '1',
          // Captures pin the living chrome (repo convention) so writes are
          // the STREAM's, not critter/glyph ambience.
          MERCURY_CRITTER_GAZE: '0',
          MERCURY_LIVE_GLYPHS: '0',
          MERCURY_TURN_RECEIPT: '0',
        },
      },
    )
    if (!existsSync(out)) {
      console.error(`✗ ${scene}: child summary missing (ptyrun stderr: ${res.stderr?.slice(0, 400)})`)
      rmSync(dir, { recursive: true, force: true })
      process.exitCode = 1
      continue
    }
    const child = JSON.parse(readFileSync(out, 'utf8')) as {
      startedAt: number
      endedAt: number
      rootCommits: number
      tailCommits: number
      deltas: number
      sentinelEmit: Record<string, number>
      fullTextTail: string
      firstDeltaAt: number
    }
    const teeLines = existsSync(tee)
      ? readFileSync(tee, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(l => {
            try {
              return JSON.parse(l) as { ts: number; len: number; content?: string }
            } catch {
              return null
            }
          })
          .filter((x): x is { ts: number; len: number; content?: string } => x !== null)
      : []

    // Stream window = first delta → stream end (child timestamps, Date.now).
    const windowStart = child.firstDeltaAt
    const windowEnd = child.endedAt
    const windowMs = Math.max(1, windowEnd - windowStart)
    const inWindow = teeLines.filter(t => t.ts >= windowStart && t.ts <= windowEnd)
    const bytes = inWindow.reduce((a, t) => a + t.len, 0)

    // Sentinel visibility: emit ts → first tee line whose VISIBLE (escape-
    // stripped, whitespace-squashed) content contains the token.
    const vis = teeLines.map(t => ({ ts: t.ts, v: t.content ? visible(t.content) : '' }))
    const lat: number[] = []
    let misses = 0
    for (const [tok, emitTs] of Object.entries(child.sentinelEmit)) {
      const hit = vis.find(t => t.ts >= emitTs && t.v.includes(tok))
      if (hit) lat.push(hit.ts - emitTs)
      else misses++
    }
    // First output: first delta emit → first write containing any fixture text
    // (proxy: the first sentinel-bearing OR any write after windowStart that
    // grew the screen; we use first write ≥ windowStart with content len>200).
    const firstOut = teeLines.find(t => t.ts >= windowStart && (t.content?.length ?? t.len) > 0)
    const firstOutputMs = firstOut ? firstOut.ts - windowStart : -1

    // Completeness: the FIN sentinel (a fresh glyph run the diff can never
    // cell-skip) reached the terminal — the settled text painted.
    const finalTextComplete = vis.some(t => t.v.includes(FIN))

    // Echo latency (typing scene): ptydrive's send log → first tee write
    // whose visible content contains the injected glyph.
    let echoMs: SceneResult['echoMs']
    if (isTyping && existsSync(drive)) {
      const sends = readFileSync(drive, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => {
          try {
            return JSON.parse(l) as { sent?: number; b64?: string }
          } catch {
            return null
          }
        })
        .filter((x): x is { sent: number; b64: string } => x?.sent !== undefined)
      const eLat: number[] = []
      let eMiss = 0
      for (const s of sends) {
        const glyph = Buffer.from(s.b64, 'base64').toString('utf8')
        const hit = vis.find(t => t.ts >= s.sent && t.v.includes(glyph))
        if (hit) eLat.push(hit.ts - s.sent)
        else eMiss++
      }
      echoMs = { p50: pct(eLat, 50), p95: pct(eLat, 95), max: eLat.length ? Math.max(...eLat) : -1, n: eLat.length, misses: eMiss }
    }

    const r: SceneResult = {
      scene,
      durationMs: windowMs,
      writes: inWindow.length,
      writesPerSec: +(inWindow.length / (windowMs / 1000)).toFixed(1),
      bytesPerSec: Math.round(bytes / (windowMs / 1000)),
      rootCommits: child.rootCommits,
      tailCommits: child.tailCommits,
      deltas: child.deltas,
      sentinelMs: { p50: pct(lat, 50), p95: pct(lat, 95), max: lat.length ? Math.max(...lat) : -1, n: lat.length, misses },
      firstOutputMs,
      finalTextComplete,
      ...(echoMs ? { echoMs } : {}),
    }
    results.push(r)
    console.log(
      `${scene.padEnd(20)} writes/s ${String(r.writesPerSec).padStart(6)} · bytes/s ${String(r.bytesPerSec).padStart(7)} · rootCommits ${String(r.rootCommits).padStart(4)} · tailCommits ${String(r.tailCommits).padStart(4)} · sentinel p50/p95/max ${r.sentinelMs.p50}/${r.sentinelMs.p95}/${r.sentinelMs.max}ms (n=${r.sentinelMs.n}${r.sentinelMs.misses ? ` MISS=${r.sentinelMs.misses}` : ''}) · firstOut ${r.firstOutputMs}ms · complete=${r.finalTextComplete}` +
        (echoMs ? ` · echo p50/p95/max ${echoMs.p50}/${echoMs.p95}/${echoMs.max}ms (n=${echoMs.n}${echoMs.misses ? ` MISS=${echoMs.misses}` : ''})` : ''),
    )
    rmSync(dir, { recursive: true, force: true })
  }

  if (process.env.MEASURE_JSON) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(process.env.MEASURE_JSON, JSON.stringify(results, null, 2))
  }
}
