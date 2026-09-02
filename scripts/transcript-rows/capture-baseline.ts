#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  findRows,
  firstOutputTs,
  grabScreens,
  pct,
  requireDist,
  runArtifactArena,
  visibleText,
  type ArenaRun,
  type GrabbedScreen,
} from '../streaming/artifactArena.ts'

requireDist()

const argv = process.argv.slice(2)
const argAfter = (flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}
const jsonOut = argAfter('--json')
const framesDir = argAfter('--frames')
const framesPrefix = argAfter('--frames-prefix') ?? 'before'
const only = (argAfter('--scene') ?? 'A,B,C,D,E,F,G').split(',')

if (framesDir) mkdirSync(framesDir, { recursive: true })

const COLS = 120
const ROWS = 40

type Vis = { ts: number; v: string }
const visLines = (run: ArenaRun): Vis[] =>
  run.teeLines.map(t => ({ ts: t.ts, v: t.content ? visibleText(t.content) : '' }))

const firstPaint = (vis: Vis[], at: number, needle: string): number => {
  const hit = vis.find(t => t.ts >= at && t.v.includes(needle))
  return hit ? hit.ts - at : -1
}
const firstWrite = (vis: Vis[], at: number): number => {
  const hit = vis.find(t => t.ts >= at && t.v.length > 0)
  return hit ? hit.ts - at : -1
}
const writesIn = (run: ArenaRun, from: number, to: number): number =>
  run.teeLines.filter(t => t.ts >= from && t.ts <= to).length

const sendTs = (run: ArenaRun, needle: string): number[] =>
  run.sendLog
    .filter(s => Buffer.from(s.b64, 'base64').toString('utf8').includes(needle))
    .map(s => s.sent)

function dumpFrames(
  scene: string,
  run: ArenaRun,
  offsets: number[],
  note: string,
): GrabbedScreen[] {
  const screens = grabScreens(run, COLS, ROWS, offsets)
  if (framesDir) {
    const parts = [`# scene ${scene} — ${note}`, '']
    for (const s of screens) {
      parts.push(`── t=+${s.atMs}ms ${'─'.repeat(40)}`)
      parts.push(...s.rows.map(r => `│${r}`))
      parts.push('')
    }
    writeFileSync(join(framesDir, `${framesPrefix}-${scene}.txt`), parts.join('\n'))
  }
  return screens
}

const contentFingerprint = (rows: string[], match: RegExp): string[] =>
  rows.flatMap((r, i) => (match.test(r) ? [`${i}:${r.trim()}`] : []))

const results: Record<string, unknown> = {}
const log = (s: string): void => console.log(s)

const mountCounts = (run: ArenaRun): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const m of run.probe?.allMarks ?? []) {
    if (m.k.startsWith('mount:') || m.k.startsWith('unmount:')) {
      out[m.k] = (out[m.k] ?? 0) + 1
    }
  }
  return out
}

if (only.includes('A')) {
  log('── scene A: prose (submit→stream→settle→idle + echo) ──')
  const WORDS = 'liquid frame cadence settle anchor lattice glyph honest state viewport'.split(' ')
  const deltas: string[] = []
  let sIdx = 0
  for (let i = 0; i < 120; i++) {
    if (i > 0 && i % 15 === 0) {
      deltas.push(`⟦S${sIdx++}⟧`)
      continue
    }
    const w = WORDS[(i * 7 + 3) % WORDS.length]!
    deltas.push(i % 40 === 39 ? `${w}.\n` : `${w} `)
  }
  const GLYPHS = ['Ξ', 'Ψ', 'Φ', 'Ω']
  const sends = ['4500:hello', '5300:\\r']
  GLYPHS.forEach((g, i) => sends.push(`${7000 + i * 600}:${g}`))
  const run = await runArtifactArena({
    turns: [{ kind: 'paced', deltas, gapMs: 40 }],
    sends,
    seconds: 16,
    probe: true,
    keep: true,
  })
  const vis = visLines(run)
  const base = firstOutputTs(run)
  const submit = sendTs(run, '\r')[0] ?? 0

  const t1 = firstWrite(vis, submit)
  const e0 = run.fixture.pacedEmits[0]
  const t2 = e0 ? firstPaint(vis, e0.at, visibleText(e0.text)) : -1
  const emits = run.fixture.pacedEmits
  const streamStart = emits[0]?.at ?? 0
  const streamEnd = emits.at(-1)?.at ?? 0
  const lat: number[] = []
  for (const e of emits) {
    if (!e.text.startsWith('⟦S')) continue
    const d = firstPaint(vis, e.at, e.text)
    if (d >= 0) lat.push(d)
  }
  const streamWrites = writesIn(run, streamStart, streamEnd)
  const streamSec = (streamEnd - streamStart) / 1000
  const echo: number[] = []
  for (const g of GLYPHS) {
    const at = sendTs(run, g)[0]
    if (!at) continue
    const d = firstPaint(vis, at, g)
    if (d >= 0) echo.push(d)
  }
  const offs = [streamEnd - base - 200, streamEnd - base + 500, streamEnd - base + 1200, -1]
  const screens = dumpFrames('A', run, offs, 'prose stream → settle swap → idle')
  const fpBefore = contentFingerprint(screens[0]!.rows, /liquid|cadence|anchor/)
  const fpAfter = contentFingerprint(screens[1]!.rows, /liquid|cadence|anchor/)
  const settleRowNoop = fpBefore.length > 0 && fpBefore.join('|') === fpAfter.join('|')
  const lastSpinner = [...vis].reverse().find(t => t.v.includes('tokens'))
  const t5 = lastSpinner ? lastSpinner.ts - streamEnd : -1

  results.A = {
    t1_submitAckMs: t1,
    t2_firstTokenPaintMs: t2,
    t3_stream: {
      writesPerSec: +(streamWrites / streamSec).toFixed(1),
      sentinelP50: pct(lat, 50),
      sentinelP95: pct(lat, 95),
      n: lat.length,
    },
    t4_settleSwapRowNoop: settleRowNoop,
    t4_rowsBefore: fpBefore,
    t4_rowsAfter: fpAfter,
    t5_spinnerExitAfterEndMs: t5,
    t6_echoUnderStream: { p50: pct(echo, 50), p95: pct(echo, 95), n: echo.length },
    mounts: mountCounts(run),
    probeFrames: run.probe?.frames ?? null,
  }
  log(`  T1 ack ${t1}ms · T2 first-token ${t2}ms · T3 ${(streamWrites / streamSec).toFixed(1)} writes/s, sentinel p95 ${pct(lat, 95)}ms (n=${lat.length})`)
  log(`  T4 settle row-noop ${settleRowNoop} · T5 spinner-exit +${t5}ms · T6 echo p50/p95 ${pct(echo, 50)}/${pct(echo, 95)}ms`)
  run.cleanup()
}

if (only.includes('B')) {
  log('── scene B: tool chain (card→receipt→tool→tool→prose) ──')
  const notes = Array.from({ length: 8 }, (_, i) => `note-line-${i + 1}`).join('\n')
  const followup: string[] = []
  for (let i = 0; i < 25; i++) followup.push(i === 24 ? 'resume-tail-end.\n' : `resume${i} `)
  const run = await runArtifactArena({
    seedCwd: { 'liquid-notes.txt': notes, 'liquid-notes2.txt': notes },
    turns: cwd => [
      {
        kind: 'paced_tool_use',
        preDeltas: Array.from({ length: 30 }, (_, i) => (i % 12 === 11 ? 'prelude.\n' : `pre${i} `)),
        gapMs: 40,
        tools: [{ name: 'Read', input: { file_path: join(cwd, 'liquid-notes.txt') } }],
      },
      { kind: 'tool_use', name: 'Read', input: { file_path: join(cwd, 'liquid-notes2.txt') } },
      { kind: 'paced', deltas: followup, gapMs: 40 },
    ],
    sends: ['4500:hello', '5300:\\r'],
    seconds: 18,
    probe: true,
    keep: true,
  })
  const vis = visLines(run)
  const base = firstOutputTs(run)

  const tool1 = run.fixture.toolEmits[0]
  const t7 = tool1 ? firstPaint(vis, tool1.at, 'liquid-notes.txt') : -1
  const t8 = tool1 ? firstPaint(vis, tool1.at, 'Read2files') : -1
  const t9at = tool1 ? tool1.at : 0
  const t9 = firstPaint(vis, t9at, 'liquid-notes2.txt')
  const resume = run.fixture.pacedEmits.find(e => e.turn === 3)
  const t10 = resume ? firstPaint(vis, resume.at, visibleText(resume.text)) : -1

  const tool1Off = (tool1?.at ?? 0) - base
  const settleOff = (run.fixture.pacedEmits.at(-1)?.at ?? 0) - base + 600
  const screens = dumpFrames(
    'B',
    run,
    [tool1Off + 80, tool1Off + 400, tool1Off + 1500, settleOff, -1],
    'individual tool card → read-group collapse → second tool → prose resume',
  )
  const cardRows = screens.map(s => {
    const individual = findRows(s.rows, 'liquid-notes.txt')[0]
    const grouped = findRows(s.rows, 'Read 2 files')[0] ?? findRows(s.rows, 'Read 1 file')[0]
    return individual !== undefined ? `${individual}:individual` : grouped !== undefined ? `${grouped}:grouped` : 'absent'
  })
  results.B = {
    t7_cardAppearMs: t7,
    t8_groupCollapseMs: t8,
    t9_secondCardMs: t9,
    t10_proseResumeMs: t10,
    cardRowAcrossLifecycle: cardRows,
    mounts: mountCounts(run),
    probeFrames: run.probe?.frames ?? null,
  }
  log(`  T7 card ${t7}ms · T8 group-collapse ${t8}ms · T9 2nd card ${t9}ms · T10 resume ${t10}ms · card ${cardRows.join(' → ')}`)
  run.cleanup()
}

if (only.includes('C')) {
  log('── scene C: permission card (input-needed → draft → approve) ──')
  const run = await runArtifactArena({
    turns: cwd => [
      {
        kind: 'tool_use',
        preText: 'Now writing a file.\n',
        name: 'Write',
        input: { file_path: join(cwd, 'liquid-out.txt'), content: 'liquid-payload\n' },
      },
      { kind: 'text', text: 'All done here.' },
    ],
    sends: [
      '4500:hello',
      '5300:\\r',
      '9000:Ξ',
      '9300:Ψ',
      '9600:Φ',
      '12000:\\r',
    ],
    seconds: 18,
    probe: true,
    keep: true,
  })
  const vis = visLines(run)
  const base = firstOutputTs(run)
  const submit = sendTs(run, '\r')[0] ?? 0

  const t11 = firstPaint(vis, submit, 'liquid-out.txt')
  const lastDraft = sendTs(run, 'Φ')[0] ?? 0
  const approve = sendTs(run, '\r')[1] ?? 0
  const t13run = approve ? firstPaint(vis, approve, 'Wrote') : -1
  const t13done = approve ? firstPaint(vis, approve, 'Alldonehere') : -1

  const screens = dumpFrames(
    'C',
    run,
    [submit - base + 800, lastDraft - base + 400, approve - base + 800, -1],
    'permission card → draft typed under it → approve → result',
  )
  const draftScreen = screens[1]!
  const draftVisible = ['Ξ', 'Ψ', 'Φ'].map(g => findRows(draftScreen.rows, g).length > 0)
  results.C = {
    t11_askAppearMs: t11,
    t12_draftGlyphsVisibleOnCardScreen: draftVisible,
    t13_approveToOutputMs: t13run,
    t13_approveToFollowupMs: t13done,
    mounts: mountCounts(run),
    probeFrames: run.probe?.frames ?? null,
  }
  log(`  T11 ask ${t11}ms · T12 draft glyphs visible ${draftVisible.join(',')} · T13 approve→output ${t13run}ms, →followup ${t13done}ms`)
  run.cleanup()
}

if (only.includes('D')) {
  log('── scene D: esc (streaming→stopping→settled) ──')
  const deltas = Array.from({ length: 150 }, (_, i) => (i % 20 === 19 ? 'stopper.\n' : `flow${i} `))
  const run = await runArtifactArena({
    turns: [{ kind: 'paced', deltas, gapMs: 50 }],
    sends: ['4500:hello', '5300:\\r', '9000:\\x1b'],
    seconds: 15,
    probe: true,
    keep: true,
  })
  const vis = visLines(run)
  const base = firstOutputTs(run)
  const esc = run.sendLog.find(s => Buffer.from(s.b64, 'base64').toString('utf8') === '\x1b')?.sent ?? 0

  const marks = run.probe?.allMarks ?? []
  const off = run.probe?.epochMinusPerfNow ?? 0
  const armed = marks.find(m => m.k === 'lifecycle:stopping' && m.v === 1)
  const cleared = marks.find(m => m.k === 'lifecycle:stopping' && m.v === 0)
  const t14 = armed ? armed.t + off - esc : -1
  const t15 = cleared && armed ? cleared.t - armed.t : -1
  const t14paint = firstPaint(vis, esc, 'stopping')
  dumpFrames('D', run, [esc - base - 100, esc - base + 300, esc - base + 1200, -1], 'esc → stopping → settled')
  results.D = {
    t14_escToStoppingArmedMs: t14,
    t14_escToStoppingPaintMs: t14paint,
    t15_stoppingToClearedMs: t15,
    probeFrames: run.probe?.frames ?? null,
  }
  log(`  T14 esc→armed ${Math.round(t14)}ms (paint ${t14paint}ms) · T15 armed→cleared ${Math.round(t15)}ms`)
  run.cleanup()
}

if (only.includes('E')) {
  log('── scene E: wheel burst + reversal during stream (echo priority) ──')
  const deltas: string[] = []
  for (let i = 1; i <= 60; i++) {
    deltas.push(`wl-line-${String(i).padStart(2, '0')} `)
    deltas.push('liquid wheel probe\n')
  }
  const UP = '\\x1b[<64;60;20M'
  const DOWN = '\\x1b[<65;60;20M'
  const sends = ['4500:hello', '5300:\\r']
  for (let i = 0; i < 12; i++) sends.push(`${8000 + i * 25}:${UP}`)
  sends.push('8150:Ξ')
  for (let i = 0; i < 4; i++) sends.push(`${8600 + i * 25}:${DOWN}`)
  sends.push('8800:Ψ')
  for (let i = 0; i < 40; i++) sends.push(`${10000 + i * 5}:${UP}`)
  sends.push('10100:Φ')
  const run = await runArtifactArena({
    turns: [{ kind: 'paced', deltas, gapMs: 40 }],
    sends,
    seconds: 15,
    probe: true,
    keep: true,
  })
  const vis = visLines(run)
  const glyphAt = sendTs(run, 'Ξ')[0] ?? 0
  const echoBurst = firstPaint(vis, glyphAt, 'Ξ')
  const echoAfter = firstPaint(vis, sendTs(run, 'Ψ')[0] ?? 0, 'Ψ')
  const denseAt = sendTs(run, 'Φ')[0] ?? 0
  const echoDense = firstPaint(vis, denseAt, 'Φ')
  const burstWrites = writesIn(run, glyphAt - 200, glyphAt + 600)
  const denseWrites = writesIn(run, denseAt - 200, denseAt + 600)
  const base = firstOutputTs(run)
  dumpFrames('E', run, [glyphAt - base - 300, glyphAt - base + 400, denseAt - base + 400, -1], 'wheel burst → echo → reversal → dense fling')
  results.E = {
    echoDuringWheelBurstMs: echoBurst,
    echoAfterReversalMs: echoAfter,
    echoDuringDenseFlingMs: echoDense,
    writesAroundBurst: burstWrites,
    writesAroundDenseFling: denseWrites,
    probeFrames: run.probe?.frames ?? null,
  }
  log(`  echo mid-burst ${echoBurst}ms · after reversal ${echoAfter}ms · mid-DENSE-fling ${echoDense}ms · writes burst/dense ${burstWrites}/${denseWrites}`)
  run.cleanup()
}

if (only.includes('F')) {
  log('── scene F: idle-rest ambient motion (MERCURY_LIVE_GLYPHS on) ──')
  const run = await runArtifactArena({
    turns: [],
    sends: [],
    seconds: 15,
    probe: true,
    keep: true,
    extraEnv: { MERCURY_LIVE_GLYPHS: '1', MERCURY_CRITTER_GAZE: '0' },
  })
  const base = firstOutputTs(run)
  const w = writesIn(run, base + 5000, base + 13000)
  const offsets = Array.from({ length: 10 }, (_, i) => 5000 + i * 800)
  const screens = grabScreens(run, COLS, ROWS, offsets)
  const changed = new Set<number>()
  for (let i = 1; i < screens.length; i++) {
    screens[i]!.rows.forEach((r, ri) => {
      if (r !== screens[i - 1]!.rows[ri]) changed.add(ri)
    })
  }
  if (framesDir) {
    const parts = ['# scene F — idle-rest motion, glyphs ON', '']
    for (const s of screens.slice(0, 4)) {
      parts.push(`── t=+${s.atMs}ms ${'─'.repeat(40)}`)
      parts.push(...s.rows.map(r => `│${r}`))
      parts.push('')
    }
    writeFileSync(join(framesDir, `${framesPrefix}-F.txt`), parts.join('\n'))
  }
  results.F = {
    idleWritesPerSec: +(w / 8).toFixed(2),
    changedRowsOverIdleWindow: [...changed].sort((a, b) => a - b),
    probeFrames: run.probe?.frames ?? null,
  }
  log(`  idle writes/s ${(w / 8).toFixed(2)} · changed rows ${[...changed].sort((a, b) => a - b).join(',')}`)
  run.cleanup()
}

if (only.includes('G')) {
  log('── scene G: working-state motion (hang turn, glyphs on) ──')
  const run = await runArtifactArena({
    turns: [{ kind: 'hang', deltas: [] }],
    sends: ['4500:hello', '5300:\\r'],
    seconds: 14,
    probe: true,
    keep: true,
    extraEnv: { MERCURY_LIVE_GLYPHS: '1', MERCURY_CRITTER_GAZE: '0' },
  })
  const base = firstOutputTs(run)
  const submit = sendTs(run, '\r')[0] ?? 0
  const w = writesIn(run, submit + 2000, base + 13000)
  const winSec = (base + 13000 - (submit + 2000)) / 1000
  const offsets = Array.from({ length: 8 }, (_, i) => submit - base + 2000 + i * 800)
  const screens = grabScreens(run, COLS, ROWS, offsets)
  const changed = new Set<number>()
  for (let i = 1; i < screens.length; i++) {
    screens[i]!.rows.forEach((r, ri) => {
      if (r !== screens[i - 1]!.rows[ri]) changed.add(ri)
    })
  }
  if (framesDir) {
    const parts = ['# scene G — working-state motion, glyphs ON (spinner active)', '']
    for (const s of screens.slice(0, 4)) {
      parts.push(`── t=+${s.atMs}ms ${'─'.repeat(40)}`)
      parts.push(...s.rows.map(r => `│${r}`))
      parts.push('')
    }
    writeFileSync(join(framesDir, `${framesPrefix}-G.txt`), parts.join('\n'))
  }
  results.G = {
    workingWritesPerSec: +(w / winSec).toFixed(2),
    changedRowsOverWorkWindow: [...changed].sort((a, b) => a - b),
    probeFrames: run.probe?.frames ?? null,
  }
  log(`  working writes/s ${(w / winSec).toFixed(2)} · changed rows ${[...changed].sort((a, b) => a - b).join(',')}`)
  run.cleanup()
}

if (only.includes('H')) {
  log('── scene H: typing during idle rest (glyphs on) ──')
  const GLYPHS = ['Ξ', 'Ψ', 'Φ', 'Ω', 'Λ', 'Θ', 'Π', 'Σ']
  const run = await runArtifactArena({
    turns: [],
    sends: GLYPHS.map((g, i) => `${6000 + i * 500}:${g}`),
    seconds: 15,
    probe: true,
    keep: true,
    extraEnv: { MERCURY_LIVE_GLYPHS: '1', MERCURY_CRITTER_GAZE: '0' },
  })
  const base = firstOutputTs(run)
  const first = Math.min(...run.sendLog.map(s => s.sent))
  const last = Math.max(...run.sendLog.map(s => s.sent))
  const typingWrites = writesIn(run, first, last + 500)
  const typingSec = (last + 500 - first) / 1000
  const idleWrites = writesIn(run, base + 3000, first - 500)
  const idleSec = (first - 500 - (base + 3000)) / 1000
  results.H = {
    idleWritesPerSec: +(idleWrites / idleSec).toFixed(2),
    typingWritesPerSec: +(typingWrites / typingSec).toFixed(2),
    keystrokes: GLYPHS.length,
    probeFrames: run.probe?.frames ?? null,
  }
  log(`  idle ${(idleWrites / idleSec).toFixed(2)} writes/s → typing window ${(typingWrites / typingSec).toFixed(2)} writes/s (${GLYPHS.length} keys over ${typingSec.toFixed(1)}s)`)
  run.cleanup()
}

if (only.includes('R')) {
  log('── scene R: requesting-mode cadence (4s held response, glyphs on) ──')
  const run = await runArtifactArena({
    turns: [{ kind: 'paced', deltas: ['requesting done.\n'], gapMs: 40, startDelayMs: 4000 }],
    sends: ['4500:hello', '5300:\\r'],
    seconds: 13,
    probe: true,
    keep: true,
    extraEnv: { MERCURY_LIVE_GLYPHS: '1', MERCURY_CRITTER_GAZE: '0' },
  })
  const submit = sendTs(run, '\r')[0] ?? 0
  const firstEmit = run.fixture.pacedEmits[0]?.at ?? submit + 4000
  const w = writesIn(run, submit + 300, firstEmit - 300)
  const winSec = (firstEmit - 300 - (submit + 300)) / 1000
  results.R = {
    requestingWritesPerSec: +(w / winSec).toFixed(2),
    windowSec: +winSec.toFixed(1),
    probeFrames: run.probe?.frames ?? null,
  }
  log(`  requesting-mode writes/s ${(w / winSec).toFixed(2)} over ${winSec.toFixed(1)}s`)
  run.cleanup()
}

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(results, null, 2))
  log(`wrote ${jsonOut}`)
}
