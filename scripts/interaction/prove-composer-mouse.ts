#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const DIST = join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail.slice(0, 300)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

section('§1 pure — the painted selection and the row-end offset')
{
  const { Cursor } = await import('../../src/utils/Cursor.ts')
  const invert = (s: string): string => `[${s}]`
  const paint = (s: string): string => `{${s}}`
  const oneRow = Cursor.fromText('hello world', 80, 6).render(' ', '', invert, undefined, undefined, {
    start: 2,
    end: 9,
    paint,
  })
  check(
    'the selection paints around the caret cell and never over it',
    oneRow === 'he{llo }[w]{or}ld',
    JSON.stringify(oneRow),
  )
  const wrapped = Cursor.fromText('the quick brown fox', 11, 19).render(' ', '', invert, undefined, undefined, {
    start: 4,
    end: 15,
    paint,
  })
  check(
    "a soft wrap's trailing blank is never painted; the caret keeps its inverse at the end",
    wrapped === 'the {quick}\n{brown} fox[ ]',
    JSON.stringify(wrapped),
  )
  const plain = Cursor.fromText('hello world', 80, 6).render(' ', '', invert)
  check('no selection renders exactly as before', plain === 'hello [w]orld', JSON.stringify(plain))
  const doc = Cursor.fromText('the quick brown fox', 11, 0).measuredText
  check(
    "a click past a wrapped row's text lands at the row's visible end, past the last row's blanks",
    doc.getLineEndOffset(0) === 9 && doc.getLineEndOffset(1) === 19,
    `${doc.getLineEndOffset(0)} ${doc.getLineEndOffset(1)}`,
  )
}

section('§2 source — the gesture road')
{
  const ink = readFileSync('src/ink/ink.tsx', 'utf8')
  const app = readFileSync('src/ink/components/App.tsx', 'utf8')
  const pi = readFileSync('src/components/PromptInput/PromptInput.tsx', 'utf8')
  const hook = readFileSync('src/hooks/useTextInput.ts', 'utf8')
  const startAt = ink.indexOf('handleSelectionStart(col: number, row: number, pressHadAlt = false): void {')
  const multiAt = ink.indexOf('handleMultiClick(col: number, row: number, count: 2 | 3): void {')
  const offerInStart = ink.indexOf('if (this.offerTextGesture(col, row, 1))', startAt)
  const offerInMulti = ink.indexOf('if (this.offerTextGesture(col, row, count))', multiAt)
  check(
    'the press is offered to the text field before the screen selection starts (click and multi-click)',
    startAt !== -1 &&
      multiAt !== -1 &&
      offerInStart !== -1 &&
      offerInStart < ink.indexOf('startSelection(this.selection, col, row)', startAt) &&
      offerInMulti !== -1 &&
      offerInMulti < ink.indexOf('startSelection(this.selection, col, row)', multiAt),
  )
  check(
    'a drag report reaches the field that took the press',
    /handleSelectionDrag\(col: number, row: number\): void \{\s*\n\s*if \(!this\.altScreenActive\) return\s*\n\s*if \(this\.textGesture\) \{/.test(ink),
  )
  const releaseAt = app.indexOf('if (props.handleSelectionRelease?.(col, row)) return')
  check(
    "the release reaches the field ahead of the root's click and hyperlink roads",
    releaseAt !== -1 && releaseAt < app.indexOf('const isClick = slop || (!hasSelection(selection) && selection.anchor !== null)'),
  )
  check(
    'the input box offers the gesture and keeps its click road for the declined cases',
    /ref=\{inputBoxRef\}\s*\n\s*onClick=\{handleInputBoxClick\}\s*\n\s*onTextGesture=\{handleInputTextGesture\}/.test(pi),
  )
  check(
    'the composer declines reverse search, vim mode and an empty composer',
    pi.includes("if (isSearchingHistory || isVimModeEnabled() || input === '') return false"),
  )
  check(
    'two clicks select the whole text',
    /if \(gesture\.clickCount >= 2\) \{\s*\n\s*gestureAnchorRef\.current = null\s*\n\s*setOwnSelection\(\{ start: 0, end: input\.length, of: input \}\)/.test(pi),
  )
  check(
    'a bare ← or → drops the range as the caret leaves it',
    /setOffset\(key\.leftArrow \? r\.start : r\.end\)\s*\n\s*onSelectionConsumed\?\.\(\)\s*\n\s*return/.test(hook),
  )
  check(
    'the painted range is the same truth the key seam reads',
    pi.includes('selectionHighlight={ownSelection}') && pi.includes('const ownSelection = ownSelectionOf(input)'),
  )
}

section('§3 pty — the real binary, SGR mouse bytes')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log(`  [SKIP] the pty legs need the posix capture driver (${driver.kind})`)
} else if (!existsSync(DIST)) {
  console.log('  [SKIP] dist/mercury.mjs missing — the pty legs need a build')
} else {
  const vendoredNode = join(ROOT, 'dist', 'vendor', 'node', 'bin', 'node')
  const nodeBin = existsSync(vendoredNode) ? vendoredNode : (Bun.which('node') ?? 'node')
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'composer-mouse-')))
  const shimDir = join(scratch, 'bin')
  mkdirSync(shimDir, { recursive: true })
  for (const exe of ['git', 'ssh']) {
    const shim = join(shimDir, exe)
    writeFileSync(shim, '#!/bin/sh\nexit 128\n')
    chmodSync(shim, 0o755)
  }
  const project = join(scratch, 'proj')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'README.md'), '# fixture project\n')
  const preload = join(scratch, 'tripwire.cjs')
  writeFileSync(
    preload,
    `'use strict'
const net = require('node:net')
const tls = require('node:tls')
const isLocal = host => host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === undefined || host === ''
const origConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const head = Array.isArray(args[0]) ? args[0][0] : args[0]
  const opts = typeof head === 'object' && head !== null ? head : { port: head, host: args[1] }
  if (opts.path) return origConnect.apply(this, args)
  if (isLocal(opts.host || 'localhost')) return origConnect.apply(this, args)
  throw new Error('tripwire: tcp ' + opts.host)
}
const origTls = tls.connect
tls.connect = function (...args) {
  const opts = typeof args[0] === 'object' && args[0] !== null ? args[0] : { port: args[0], host: args[1] }
  if (isLocal(opts.host || opts.servername || 'localhost')) return origTls.apply(this, args)
  throw new Error('tripwire: tls ' + opts.host)
}
try { require('node:module').syncBuiltinESMExports() } catch {}
const origFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const target = typeof input === 'string' ? input : String((input && input.url) || input)
  let host = ''
  try { host = new URL(target).hostname } catch {}
  if (isLocal(host)) return origFetch(input, init)
  return Promise.reject(new Error('tripwire: fetch ' + target))
}
`,
  )

  const seededHome = (name: string): string => {
    const home = join(scratch, name)
    seedFirstRun(home, [project])
    const cfgPath = join(home, '.mercury.json')
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
    cfg['copyOnSelect'] = false
    writeFileSync(cfgPath, JSON.stringify(cfg))
    return home
  }
  const childEnv = (home: string): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}`,
      NODE_OPTIONS: `--require ${preload}`,
      HOME: join(scratch, 'home'),
      MERCURY_CONFIG_DIR: home,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_OPERATOR: 'sam',
      USER: 'sam',
      TERM: 'xterm-256color',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      MERCURY_BOOT_PREFLIGHT: '0',
      MERCURY_CRITTER_IDLE: '0',
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_CRITTER_SLEEP: '0',
      MERCURY_LIVE_CLOCK: '0',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_TURN_RECEIPT: '0',
      MERCURY_UPDATE_NOTICE: '0',
      BROWSER: '/usr/bin/true',
    }
    for (const key of [
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY',
      'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY',
      'MERCURY_CONCOURSE', 'MERCURY_CONCOURSE_FIXTURE', 'NODE_ENV', 'CI', 'VSHOT_ACTIVE',
    ]) {
      delete env[key]
    }
    mkdirSync(env.HOME!, { recursive: true })
    return env
  }

  type Cell = { c: string; bg: string; rev: boolean }
  type Cursor = { x: number; y: number }
  type Mark = { label: string; grid: Cell[][]; cursor: Cursor }
  type Capture = { marks: Map<string, Mark> }

  const T1 = 'the quick brown fox jumps over the lazy dog'
  const T2 =
    'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega and then the letters begin again alpha beta gamma delta epsilon zeta'
  const PRESS = '\x1b[<0;{X};{Y}M'
  const MOVE = '\x1b[<32;{X};{Y}M'
  const RELEASE = '\x1b[<0;{X};{Y}m'
  const CLICK = PRESS + RELEASE
  const opening = (text: string): Record<string, unknown>[] => [
    { atTick: 80, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r' },
    { atTick: 160, awaitText: 'Type a prompt', minTick: 5, awaitStableTicks: 2, requireAwait: true, data: text },
  ]
  const mark = (label: string): Record<string, unknown> => ({ afterPrevTicks: 5, data: '', mark: label })
  const aim = (needle: string, dx: number, data: string): Record<string, unknown> => ({
    afterPrevTicks: 4,
    targetText: needle,
    targetDx: dx,
    data,
  })

  const capture = (tag: string, size: { cols: number; rows: number }, text: string, sends: Record<string, unknown>[]): Capture | null => {
    const home = seededHome(`home-${tag}`)
    const gridPath = join(scratch, `${tag}.json`)
    const cfgPath = join(scratch, `${tag}-cfg.json`)
    writeFileSync(
      cfgPath,
      JSON.stringify({
        argv: [nodeBin, DIST, '--chat'],
        cwd: project,
        sends: [...opening(text), ...sends],
        total: 220,
        stableTicks: 4,
        cols: size.cols,
        rows: size.rows,
        out: gridPath,
        title: tag,
      }),
    )
    const res = spawnSync(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], {
      env: childEnv(home),
      cwd: project,
      encoding: 'utf8',
      timeout: vshotBudgetMs(120_000),
    })
    if (res.status !== 0 || !existsSync(gridPath)) {
      check(`${tag}: the capture ran`, false, (res.stderr ?? '').slice(-400))
      return null
    }
    const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as { marks?: Mark[] }
    return { marks: new Map((payload.marks ?? []).map(m => [m.label, m])) }
  }

  const rowText = (grid: Cell[][], y: number): string => (grid[y] ?? []).map(c => c.c).join('')
  const locate = (grid: Cell[][], needle: string): { y: number; x: number } | null => {
    for (let y = 0; y < grid.length; y++) {
      const x = rowText(grid, y).indexOf(needle)
      if (x !== -1) return { y, x }
    }
    return null
  }
  const highlighted = (grid: Cell[][], y: number): number[] => {
    const row = grid[y] ?? []
    const ground = row[0]?.bg
    const out: number[] = []
    for (let x = 0; x < row.length; x++) if (row[x]!.bg !== ground) out.push(x)
    return out
  }
  const span = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i)
  const same = (a: number[], b: number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i])
  const frameHighlighted = (grid: Cell[][], y: number, cols: number): boolean => {
    const hi = highlighted(grid, y)
    return hi.includes(0) || hi.includes(cols - 1)
  }

  for (const size of [
    { cols: 120, rows: 40 },
    { cols: 82, rows: 17 },
  ]) {
    const at = `${size.cols}x${size.rows}`
    console.log(`\n  ── ${at}`)

    const a = capture(`click-${at}`, size, T1, [
      mark('typed'),
      aim('quick brown', 6, CLICK),
      mark('after-click'),
      aim('quick brown', 0, PRESS),
      aim('quick brown', 5, MOVE),
      aim('quick brown', 10, MOVE),
      mark('drag-mid'),
      aim('quick brown', 10, RELEASE),
      mark('after-drag'),
      { afterPrevTicks: 4, data: '\x1b[D' },
      mark('after-left'),
      { afterPrevTicks: 4, data: 'Z' },
      mark('after-left-type'),
      aim('quick brown', 0, PRESS),
      aim('quick brown', 10, MOVE),
      aim('quick brown', 10, RELEASE),
      mark('after-drag-2'),
      { afterPrevTicks: 4, data: 'X' },
      mark('after-type'),
    ])
    if (a) {
      const typed = a.marks.get('typed')!
      const home = locate(typed.grid, T1)
      check(`${at}: the typed text is on one composer row`, home !== null)
      if (home) {
        const q = home.x + 4
        const b = home.x + 10
        const n = home.x + 14
        const clicked = a.marks.get('after-click')!
        check(
          `${at}: a click lands the caret on the clicked character`,
          clicked.cursor.x === b && clicked.cursor.y === home.y,
          `cursor (${clicked.cursor.x},${clicked.cursor.y}) wanted (${b},${home.y})`,
        )
        const mid = a.marks.get('drag-mid')!
        check(
          `${at}: a drag in progress highlights exactly the text between the press and the pointer`,
          same(highlighted(mid.grid, home.y), span(q, n)),
          `highlighted ${JSON.stringify(highlighted(mid.grid, home.y))} wanted ${q}..${n}`,
        )
        check(`${at}: the frame is never part of the drag`, !frameHighlighted(mid.grid, home.y, size.cols))
        check(`${at}: the caret sits on the far side of the pointer's cell during the drag`, mid.cursor.x === n + 1, `cursor x ${mid.cursor.x}`)
        const after = a.marks.get('after-drag')!
        check(`${at}: the highlight stays after the release`, same(highlighted(after.grid, home.y), span(q, n)))
        const left = a.marks.get('after-left')!
        check(
          `${at}: ← clears the selection and lands the caret at its start`,
          highlighted(left.grid, home.y).length === 0 && left.cursor.x === q,
          `highlighted ${highlighted(left.grid, home.y).length} cursor x ${left.cursor.x}`,
        )
        const leftTyped = a.marks.get('after-left-type')!
        check(
          `${at}: typing after ← inserts, it does not replace`,
          rowText(leftTyped.grid, home.y).includes('the Zquick brown fox jumps over the lazy dog'),
          rowText(leftTyped.grid, home.y).trim(),
        )
        const typedOver = a.marks.get('after-type')!
        check(
          `${at}: typing over a selection replaces it`,
          rowText(typedOver.grid, home.y).includes('the ZX fox jumps over the lazy dog'),
          rowText(typedOver.grid, home.y).trim(),
        )
      }
    }

    const b = capture(`dbl-${at}`, size, T1, [
      mark('typed'),
      aim('quick brown', 6, CLICK + CLICK),
      mark('after-dbl'),
      { afterPrevTicks: 4, data: 'Y' },
      mark('after-dbl-type'),
    ])
    if (b) {
      const typed = b.marks.get('typed')!
      const home = locate(typed.grid, T1)
      if (home) {
        const dbl = b.marks.get('after-dbl')!
        check(
          `${at}: two clicks select the whole text and nothing beyond it`,
          same(highlighted(dbl.grid, home.y), span(home.x, home.x + T1.length - 1)),
          `highlighted ${JSON.stringify(highlighted(dbl.grid, home.y)).slice(0, 80)} wanted ${home.x}..${home.x + T1.length - 1}`,
        )
        check(`${at}: the frame is never part of the double-click`, !frameHighlighted(dbl.grid, home.y, size.cols))
        const replaced = b.marks.get('after-dbl-type')!
        const row = rowText(replaced.grid, home.y)
        check(`${at}: typing over the whole selection leaves only the typed character`, /❯ Y\s*│?\s*$/.test(row), row.trim())
      }
    }

    const c = capture(`rows-${at}`, size, T2, [
      mark('typed'),
      aim('gamma delta', 0, PRESS),
      aim('gamma delta', 3, MOVE),
      aim('the letters', 4, MOVE),
      mark('rows-mid'),
      aim('the letters', 4, RELEASE),
      mark('rows-after'),
    ])
    if (c) {
      const typed = c.marks.get('typed')!
      const first = locate(typed.grid, 'gamma delta')
      const later = locate(typed.grid, 'the letters')
      check(`${at}: the long text wraps and the two targets sit on different rows`, first !== null && later !== null && later!.y > first!.y)
      if (first && later && later.y > first.y) {
        const mid = c.marks.get('rows-mid')!
        const firstRowText = rowText(typed.grid, first.y)
        const frameRight = firstRowText.lastIndexOf('│')
        const lastTextCell = firstRowText.slice(0, frameRight).replace(/\s+$/, '').length - 1
        const hiFirst = highlighted(mid.grid, first.y)
        check(
          `${at}: on the first row the highlight runs from the press to the row's last text cell, never into the blank tail`,
          same(hiFirst, span(first.x, lastTextCell)),
          `highlighted ${hiFirst[0]}..${hiFirst[hiFirst.length - 1]} (${hiFirst.length}) wanted ${first.x}..${lastTextCell}`,
        )
        const hiLater = highlighted(mid.grid, later.y)
        const laterTextStart = rowText(typed.grid, later.y).slice(1).search(/\S/) + 1
        check(
          `${at}: on the pointer's row the highlight runs from the text start through the pointer's cell`,
          same(hiLater, span(laterTextStart, later.x + 4)),
          `highlighted ${hiLater[0]}..${hiLater[hiLater.length - 1]} (${hiLater.length}) wanted ${laterTextStart}..${later.x + 4}`,
        )
        for (let y = first.y; y <= later.y; y++) {
          check(`${at}: row ${y} — the frame is never part of the selection`, !frameHighlighted(mid.grid, y, size.cols))
        }
      }
    }
  }
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` ❌ prove-composer-mouse: ${failures} failure(s)`)
  process.exit(1)
}
console.log(' ✅ composer-mouse — click lands · drag selects text · two clicks select all · typing replaces')
