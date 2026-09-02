#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-transcript-window-identity.ts — the stacked-copies seal on
//  the SHIPPED binary: a 1,000-row resumed transcript, scrolled off its tail,
//  walked in cursor mode, resized — and the virtual list never paints a row
//  twice nor carries a stale or duplicate sibling key.
//
//  The short fixtures that once passed never moved the window's start, so
//  React reconciled the list by position and the duplicate-key zombie stayed
//  invisible. This capture boots dist/mercury.mjs `--resume` onto the
//  deterministic 1k fixture (scripts/navigation/fixture1k.ts — prose, code,
//  diffs, tool cards, CJK, a wide table), waits for the tail, pages up six
//  times (the mounted window leaves both ends), enters message-actions
//  cursor mode and walks it, leaves, and takes a width resize mid-run. The
//  MERCURY_CONNECTOR_TRACE seam records every list render (its mounted
//  range, stale-key count and duplicate keys); the marks and the final grid
//  are read for painted duplicates by the chapter headings, which occur
//  exactly once each in the fixture.
//
//  Run: bun scripts/ui/prove-transcript-window-identity.ts
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_HOME, RUNTIME_CWD, cleanupScenario, encodeFixtureTranscript, scenario } from './renderScenarios.ts'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { buildCompass1k, COMPASS_SID, TAIL_SENTINEL } from '../navigation/fixture1k.ts'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

type Cell = { c?: string }
type Grid = Cell[][]
type Payload = { grid?: Grid; marks?: Array<{ label: string; grid: Grid; cols: number; rows: number }>; endReason?: string }
const text = (g: Grid | undefined): string => (Array.isArray(g) ? g.map(row => row.map(cell => cell.c ?? ' ').join('')).join('\n') : '')
const count = (hay: string, needle: string): number => hay.split(needle).length - 1

type ListRender = { range: [number, number]; messages: number; keys: number; stale: number; dupKeys: string[] }

console.log('transcript window identity — the 1k resume, scrolled, walked, resized')

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`  no POSIX pty capture driver on this host (${driver.kind}) — the screen leg cannot run here`)
  failures++
} else if (!existsSync(BIN)) {
  console.error('  dist/mercury.mjs missing — bun run build.ts first')
  failures++
} else {
  // The hermetic capture profile (every pin the render scenarios apply) —
  // then the argv points at the staged 1k fixture instead of the short one.
  const base = scenario('resume-2turn', 120, 40)
  const projects = join(CONFIG_HOME, 'projects', sanitizePath(RUNTIME_CWD))
  mkdirSync(projects, { recursive: true })
  const staged = join(projects, `${COMPASS_SID}.jsonl`)
  writeFileSync(staged, encodeFixtureTranscript(buildCompass1k(RUNTIME_CWD).lines, COMPASS_SID))
  const scratch = join(CONFIG_HOME, 'window-identity')
  mkdirSync(scratch, { recursive: true })
  const trace = join(scratch, 'connector-trace.jsonl')
  rmSync(trace, { force: true })
  const gridPath = join(scratch, 'grid.json')
  const cfgPath = join(scratch, 'vshot.json')

  const PAGE_UP = '\x1b[5~'
  const SHIFT_UP = '\x1b[1;2A'
  const UP = '\x1b[A'
  const ESC = '\x1b'
  const sends = [
    // The resumed tail on screen and settled — the strict gate: nothing fires
    // blind into a boot that has not painted the fixture.
    { requireAwait: true, awaitText: TAIL_SENTINEL, awaitStableTicks: 3, mark: 'loaded', data: '' },
    { afterPrevTicks: 2, data: PAGE_UP },
    { afterPrevTicks: 2, data: PAGE_UP },
    { afterPrevTicks: 2, data: PAGE_UP },
    { afterPrevTicks: 2, data: PAGE_UP },
    { afterPrevTicks: 2, data: PAGE_UP },
    { afterPrevTicks: 2, data: PAGE_UP },
    { afterPrevTicks: 4, mark: 'scrolled', data: '' },
    // Cursor mode from the empty composer; the bar's own words gate the walk.
    { afterPrevTicks: 2, data: SHIFT_UP },
    { requireAwait: true, awaitText: 'navigate', awaitSettleTicks: 1, mark: 'cursor', data: UP },
    { afterPrevTicks: 2, data: UP },
    { afterPrevTicks: 2, data: UP },
    { afterPrevTicks: 3, mark: 'walked', data: ESC },
    // Past the resize tick: the capture keeps running so the post-resize
    // renders land in the trace and the final grid is the resized one.
    { atTick: 140, mark: 'resized', data: '' },
  ]
  const cfg = {
    ...base,
    argv: ['node', BIN, '--resume', COMPASS_SID],
    sends,
    resizes: [{ atTick: 125, cols: 100, rows: 40 }],
    total: 160,
    cols: 120,
    rows: 40,
    out: gridPath,
  }
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const res = spawnSync(driver.python, [join(import.meta.dir, 'vshot.py'), cfgPath], {
    encoding: 'utf-8',
    cwd: RUNTIME_CWD,
    timeout: vshotBudgetMs(150_000),
    env: {
      ...process.env,
      MERCURY_FULLSCREEN: '1',
      MERCURY_CONFIG_DIR: CONFIG_HOME,
      MERCURY_CONNECTOR_TRACE: trace,
      // No turn is ever sent; the API base points at a closed port.
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    },
  })
  check('the capture delivered every send', res.status === 0, `exit ${res.status}: ${(res.stderr ?? '').trim().slice(-400)}`)

  let payload: Payload = {}
  try {
    payload = JSON.parse(readFileSync(gridPath, 'utf8')) as Payload
  } catch {
    check('the grid payload is readable', false, gridPath)
  }
  const marks = new Map<string, string>()
  for (const m of payload.marks ?? []) marks.set(m.label, text(m.grid))
  const final = text(payload.grid)

  console.log('\n— the screen —')
  check('the 1k tail was on screen at the loaded mark', (marks.get('loaded') ?? '').includes(TAIL_SENTINEL))
  check('six page-ups scrolled the tail off screen (the window left the tail)', marks.has('scrolled') && !(marks.get('scrolled') ?? '').includes(TAIL_SENTINEL))
  check('cursor mode opened (the action bar names the walk)', (marks.get('cursor') ?? '').includes('navigate') && (marks.get('cursor') ?? '').includes('esc'))
  check('the resize landed (the final grid is 100 columns wide)', Array.isArray(payload.grid) && payload.grid[0]?.length === 100, `${payload.grid?.[0]?.length}`)
  // Every chapter heading occurs exactly once in the fixture: any frame that
  // paints one twice has a stacked copy.
  const frames: Array<[string, string]> = [...marks.entries(), ['final', final]]
  const doubled: string[] = []
  for (const [label, frame] of frames) {
    for (let c = 1; c <= 53; c++) {
      if (count(frame, `Chapter ${c}:`) > 1) doubled.push(`${label}:Chapter ${c}`)
    }
    if (count(frame, TAIL_SENTINEL) > 1) doubled.push(`${label}:tail`)
  }
  check('no frame paints a chapter heading or the tail twice (no stacked copies)', doubled.length === 0, doubled.join(' · '))

  console.log('\n— the trace (every virtual list render) —')
  let renders: ListRender[] = []
  if (existsSync(trace)) {
    renders = readFileSync(trace, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line) as { ev?: string } & ListRender
        } catch {
          return null
        }
      })
      .filter((r): r is { ev?: string } & ListRender => r !== null && r.ev === 'list-render')
  }
  check('the list rendered under the trace seam (renders recorded)', renders.length > 0, `${renders.length}`)
  // The walk, compactly — the diagnosis when a leg below reds.
  console.log(`  renders: ${renders.map(r => `[${r.range[0]},${r.range[1]})/${r.messages}`).join(' ')}`)
  const stale = renders.filter(r => r.stale > 0).length
  check('no render carried a stale key (every mounted index exact)', stale === 0, `${stale} of ${renders.length}`)
  const dup = renders.filter(r => r.dupKeys.length > 0)
  check('no render carried a duplicate sibling key', dup.length === 0, dup.slice(0, 3).map(r => r.dupKeys.join(',')).join(' | '))
  const offHead = renders.filter(r => r.range[0] > 0 && r.range[1] < r.messages).length
  check('the mounted window left BOTH ends during the run (the keyed-map path was exercised)', offHead > 0, `${offHead} of ${renders.length}`)
  // 1,011 records fold into ~800 painted rows (tool pairs group, read/search
  // groups collapse): the long-session floor is 300 painted rows.
  check('the list saw a long transcript (≥ 300 painted rows)', renders.some(r => r.messages >= 300), `max ${Math.max(0, ...renders.map(r => r.messages))}`)
  check('the key cache never outran the rows', renders.every(r => r.keys === r.messages), renders.filter(r => r.keys !== r.messages).slice(0, 2).map(r => `${r.keys}/${r.messages}`).join(' '))

  rmSync(staged, { force: true })
  rmSync(scratch, { recursive: true, force: true })
  cleanupScenario('resume-2turn')
}

console.log(failures === 0 ? '\ntranscript window identity: HOLDS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
