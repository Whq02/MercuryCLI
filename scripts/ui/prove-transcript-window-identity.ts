#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
type Payload = { grid?: Grid; marks?: Array<{ label: string; grid: Grid; cols: number; rows: number }>; endReason?: string; sendReceipts?: Array<{ atTick: number; ts: number }> }
const text = (g: Grid | undefined): string => (Array.isArray(g) ? g.map(row => row.map(cell => cell.c ?? ' ').join('')).join('\n') : '')
const count = (hay: string, needle: string): number => hay.split(needle).length - 1

type ListRender = { range: [number, number]; messages: number; keys: number; stale: number; dupKeys: string[]; scroll?: { top: number; pending: number; sticky: boolean; viewport: number; height: number } | null }
type ScrollRequest = { t: number; delta: number; top: number; pending: number; max: number; viewport: number; sticky: boolean }

console.log('transcript window identity — the 1k resume, scrolled, walked, resized')

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`  no POSIX pty capture driver on this host (${driver.kind}) — the screen leg cannot run here`)
  failures++
} else if (!existsSync(BIN)) {
  console.error('  dist/mercury.mjs missing — bun run build.ts first')
  failures++
} else {
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
  const PAGE_DOWN = '\x1b[6~'
  const CTRL_HOME = '\x1b[1;5H'
  const SHIFT_UP = '\x1b[1;2A'
  const UP = '\x1b[A'
  const ESC = '\x1b'
  const sends = [
    { requireAwait: true, awaitText: TAIL_SENTINEL, awaitStableTicks: 3, mark: 'loaded', data: '' },
    { afterPrevTicks: 2, data: PAGE_UP },
    { afterPrevTicks: 2, data: PAGE_UP },
    { afterPrevTicks: 2, data: PAGE_UP },
    { afterPrevTicks: 2, data: PAGE_UP },
    { afterPrevTicks: 2, data: PAGE_UP },
    { afterPrevTicks: 2, data: PAGE_UP },
    { afterPrevTicks: 4, mark: 'scrolled', data: '' },
    { afterPrevTicks: 2, data: CTRL_HOME },
    { afterPrevTicks: 4, mark: 'home', data: PAGE_DOWN },
    ...Array.from({ length: 23 }, () => ({ afterPrevTicks: 1, data: PAGE_DOWN })),
    { afterPrevTicks: 5, mark: 'paged', data: '' },
    { afterPrevTicks: 2, data: SHIFT_UP },
    { requireAwait: true, awaitText: 'navigate', awaitSettleTicks: 1, mark: 'cursor', data: UP },
    { afterPrevTicks: 2, data: UP },
    { afterPrevTicks: 2, data: UP },
    { afterPrevTicks: 3, mark: 'walked', data: ESC },
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
  const paneRowsOf = (rows: string[]): number =>
    rows.slice(2, 36).filter(r => {
      const inner = r.replace(/^[^│]*│/, '').replace(/│\s*$/, '')
      return /\S/.test(inner)
    }).length
  const paneRows = (label: string): number => paneRowsOf((marks.get(label) ?? '').split('\n'))
  for (const [label, frame] of marks) {
    const rows = frame.split('\n')
    const nameplated = rows.filter(r => /\] ❯ /.test(r))
    const first = nameplated[0]?.replace(/^.*?\] ❯ /, '').trim().slice(0, 60) ?? '(no prompt row on screen)'
    console.log(`  ${label}: ${paneRowsOf(rows)} painted transcript rows · first prompt row on screen: "${first}"`)
  }
  check('the 1k tail was on screen at the loaded mark', (marks.get('loaded') ?? '').includes(TAIL_SENTINEL))
  check('six page-ups scrolled the tail off screen (the window left the tail)', marks.has('scrolled') && !(marks.get('scrolled') ?? '').includes(TAIL_SENTINEL))
  check('the scrolled viewport is painted, not the spacer (the window followed the scroll)', paneRows('scrolled') >= 12, `${paneRows('scrolled')} painted rows`)
  const HEAD_ROW = '] ❯ load the compass baseline fixture'
  check('ctrl+home reached the head (the first prompt’s row on screen)', (marks.get('home') ?? '').includes(HEAD_ROW))
  check('the pages down from the head paint content, not the spacer', paneRows('paged') >= 12, `${paneRows('paged')} painted rows`)
  check('the pages down left the head behind (the first prompt’s row is off screen; its words may ride the sticky header)', marks.has('paged') && !(marks.get('paged') ?? '').includes(HEAD_ROW))
  check('cursor mode opened (the action bar names the walk)', (marks.get('cursor') ?? '').includes('navigate') && (marks.get('cursor') ?? '').includes('esc'))
  check('the resize landed (the final grid is 100 columns wide)', Array.isArray(payload.grid) && payload.grid[0]?.length === 100, `${payload.grid?.[0]?.length}`)
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
  let requests: ScrollRequest[] = []
  if (existsSync(trace)) {
    const lines = readFileSync(trace, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line) as { ev?: string } & Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter((r): r is { ev?: string } & Record<string, unknown> => r !== null)
    renders = lines.filter(r => r.ev === 'list-render') as unknown as ListRender[]
    requests = lines.filter(r => r.ev === 'scroll-request') as unknown as ScrollRequest[]
  }
  const receipts = payload.sendReceipts ?? []
  const sendIndexOf = (label: string): number => sends.findIndex(x => x.mark === label)
  const homeAt = receipts[sendIndexOf('home')]?.ts
  const pagedAt = receipts[sendIndexOf('paged')]?.ts
  const pagesSent = sends.filter((x, i) => i >= sendIndexOf('home') && i < sendIndexOf('paged') && x.data === PAGE_DOWN).length
  const pageRequests = homeAt !== undefined && pagedAt !== undefined ? requests.filter(r => r.delta > 0 && r.t >= homeAt - 50 && r.t <= pagedAt + 50) : []
  console.log(`  page-downs sent ${pagesSent} · scroll requests in the phase ${pageRequests.length} · tops: ${pageRequests.map(r => r.top).join(' ')}`)
  check('every page-down press reached the scroller (no key lost to a paint)', pageRequests.length === pagesSent, `${pageRequests.length} of ${pagesSent}`)
  if (pageRequests.length >= 2) {
    const first = pageRequests[0]!
    const last = pageRequests[pageRequests.length - 1]!
    const step = Math.max(1, first.viewport - 2)
    const travelled = last.top - first.top
    const asked = (pageRequests.length - 1) * step
    check(`the presses travelled (${travelled} rows over ${pageRequests.length - 1} gaps of ${step}; the clamp did not swallow them)`, travelled >= Math.floor(asked * 0.75), `${travelled} of ${asked}`)
  }
  check('the list rendered under the trace seam (renders recorded)', renders.length > 0, `${renders.length}`)
  console.log(`  renders: ${renders.map(r => `[${r.range[0]},${r.range[1]})/${r.messages}${r.scroll ? `@${r.scroll.top}${r.scroll.pending ? `+${r.scroll.pending}` : ''}${r.scroll.sticky ? 's' : ''}/${r.scroll.height}` : ''}`).join(' ')}`)
  const viewports = [...new Set(renders.map(r => r.scroll?.viewport).filter((v): v is number => typeof v === 'number' && v > 0))]
  console.log(`  viewport rows seen: ${viewports.join(', ') || '(none)'} — a page step is viewport − 2`)
  const stale = renders.filter(r => r.stale > 0).length
  check('no render carried a stale key (every mounted index exact)', stale === 0, `${stale} of ${renders.length}`)
  const dup = renders.filter(r => r.dupKeys.length > 0)
  check('no render carried a duplicate sibling key', dup.length === 0, dup.slice(0, 3).map(r => r.dupKeys.join(',')).join(' | '))
  const offHead = renders.filter(r => r.range[0] > 0 && r.range[1] < r.messages).length
  check('the mounted window left BOTH ends during the run (the keyed-map path was exercised)', offHead > 0, `${offHead} of ${renders.length}`)
  const reachedHead = renders.filter(r => r.range[0] === 0 && r.range[1] < r.messages).length
  check('the window reached the head (ctrl+home re-windowed the list)', reachedHead > 0, `${reachedHead} of ${renders.length}`)
  check('the list saw a long transcript (≥ 300 painted rows)', renders.some(r => r.messages >= 300), `max ${Math.max(0, ...renders.map(r => r.messages))}`)
  check('the key cache never outran the rows', renders.every(r => r.keys === r.messages), renders.filter(r => r.keys !== r.messages).slice(0, 2).map(r => `${r.keys}/${r.messages}`).join(' '))

  rmSync(staged, { force: true })
  if (failures === 0) {
    rmSync(scratch, { recursive: true, force: true })
  } else {
    const keep = join(tmpdir(), 'mercury-window-identity-diagnosis')
    rmSync(keep, { recursive: true, force: true })
    mkdirSync(keep, { recursive: true })
    for (const name of ['grid.json', 'connector-trace.jsonl', 'vshot.json']) {
      if (existsSync(join(scratch, name))) copyFileSync(join(scratch, name), join(keep, name))
    }
    writeFileSync(join(keep, 'marks.txt'), [...marks.entries(), ['final', final]].map(([label, frame]) => `──── ${label} ────\n${frame}`).join('\n\n'))
    rmSync(scratch, { recursive: true, force: true })
    console.log(`  kept for diagnosis: ${keep} (grid.json · connector-trace.jsonl · marks.txt)`)
  }
  cleanupScenario('resume-2turn')
}

console.log(failures === 0 ? '\ntranscript window identity: HOLDS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
