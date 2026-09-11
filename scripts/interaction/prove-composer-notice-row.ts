#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const bundleFlag = process.argv.indexOf('--bundle')
const DIST =
  bundleFlag !== -1 && process.argv[bundleFlag + 1] !== undefined
    ? realpathSync(process.argv[bundleFlag + 1]!)
    : join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail.slice(0, 300)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

section('§1 source — the notice leaves the column for the hint row')
{
  const column = readFileSync('src/components/PromptInput/Notifications.tsx', 'utf8')
  const footer = readFileSync('src/components/PromptInput/PromptInputFooterLeftSide.tsx', 'utf8')
  const summary = readFileSync('src/components/tasks/CompactWorkSummary.tsx', 'utf8')
  const sandbox = readFileSync('src/components/PromptInput/SandboxPromptFooterHint.tsx', 'utf8')
  check(
    'the notifications column paints no transient row',
    !column.includes('{footerNoticeLine(current.text)}') && !column.includes("'jsx' in current ? ("),
  )
  check(
    'the hint row reads the current notice and paints it after the hints',
    footer.includes('const currentNotice = useAppState((state: AppState) => state.notifications.current)') &&
      footer.includes('if (noticeJoinsParts) parts.push(noticeText)') &&
      /\{!noticeJoinsParts && noticeText !== null \? \(\s*\n\s*<Box flexShrink=\{1\} minWidth=\{0\}>/.test(footer),
  )
  check(
    'the idle hint keeps its words and its click road beside the notice',
    footer.includes('for commands + files') && /onClick=\{\(\) => \{[\s\S]{0,240}requestCommandDispatch\('\/help'\)/.test(footer),
  )
  check(
    "the compact layout's count line carries the notice after the counts, the counts shedding to their short form to make room",
    summary.includes('const noticeText = noticeRowText(currentNotice)') &&
      summary.includes("const noticeWidth = currentNotice !== null && !('jsx' in currentNotice) ? stringWidth(footerNoticeLine(currentNotice.text)) + 3 : 0") &&
      /\{compactWorkSummaryText\(counts, Math\.max\(0, columns - hintWidth - noticeWidth\)\)\}\s*\n\s*\{noticeText !== null \? \(/.test(summary),
  )
  check(
    'the sandbox notice rides the notification queue instead of a row of its own',
    sandbox.includes("key: 'sandbox-blocked'") && !sandbox.includes('recentCount') && sandbox.includes('return null'),
  )
}

section('§2 pure — the notice in its row form')
{
  const React = (await import('react')).default
  const { Box, Text } = await import('../../src/ink.ts')
  const { footerNoticeLine, noticeRowBlock, noticeRowText } = await import('../../src/components/PromptInput/Notifications.tsx')
  const plain = noticeRowText({ key: 'k', priority: 'immediate', text: 'Copied to clipboard' })
  check('a plain text notice is its one line', plain === 'Copied to clipboard', JSON.stringify(plain))
  const folded = noticeRowText({ key: 'k', priority: 'low', text: 'hook said\nline two\nline three' })
  check(
    'a multi-line text folds to the one row through footerNoticeLine',
    folded === 'hook said · line two · line three' && folded === footerNoticeLine('hook said\nline two\nline three'),
    JSON.stringify(folded),
  )
  const red = noticeRowText({ key: 'k', priority: 'high', text: 'failed', color: 'error' })
  check(
    'a coloured notice keeps its colour on the row',
    React.isValidElement(red) && red.type === Text && (red.props as { color?: string }).color === 'error',
  )
  const textJsx = React.createElement(Text, { dimColor: true }, 'ctrl+r searches history')
  check(
    'a Text-shaped notice rides inline and is never a block',
    noticeRowText({ key: 'k', priority: 'immediate', jsx: textJsx }) === textJsx &&
      noticeRowBlock({ key: 'k', priority: 'immediate', jsx: textJsx }) === null,
  )
  const boxJsx = React.createElement(Box, { flexDirection: 'column' }, React.createElement(Text, null, 'row'))
  check(
    'a Box-shaped notice is a block and never rides inline',
    noticeRowText({ key: 'k', priority: 'high', jsx: boxJsx }) === null &&
      noticeRowBlock({ key: 'k', priority: 'high', jsx: boxJsx }) === boxJsx,
  )
  check('no notice, nothing on the row', noticeRowText(null) === null && noticeRowBlock(null) === null)
}

section('§3 pty — the real binary: the receipt and the escape hint ride the hint row, the composer never moves')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log(`  [SKIP] the pty legs need the posix capture driver (${driver.kind})`)
} else if (!existsSync(DIST)) {
  console.log('  [SKIP] dist/mercury.mjs missing — the pty legs need a build')
} else {
  const vendoredNode = join(ROOT, 'dist', 'vendor', 'node', 'bin', 'node')
  const nodeBin = existsSync(vendoredNode) ? vendoredNode : (Bun.which('node') ?? 'node')
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'composer-notice-row-')))
  const shimDir = join(scratch, 'bin')
  mkdirSync(shimDir, { recursive: true })
  for (const exe of ['git', 'ssh']) {
    const shim = join(shimDir, exe)
    writeFileSync(shim, '#!/bin/sh\nexit 128\n')
    chmodSync(shim, 0o755)
  }
  for (const exe of ['pbcopy', 'pbpaste', 'xclip', 'xsel', 'wl-copy']) {
    const shim = join(shimDir, exe)
    writeFileSync(shim, '#!/bin/sh\ncat >/dev/null\nexit 0\n')
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

  const seededHome = (name: string, copyOnSelect: boolean): string => {
    const home = join(scratch, name)
    seedFirstRun(home, [project])
    const cfgPath = join(home, '.mercury.json')
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
    cfg['copyOnSelect'] = copyOnSelect
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
      'MERCURY_CONCOURSE', 'MERCURY_CONCOURSE_FIXTURE', 'NODE_ENV', 'CI', 'VSHOT_ACTIVE', 'TMUX', 'SSH_CONNECTION',
      'VISUAL', 'EDITOR',
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
  const RECEIPT = 'Copied to clipboard'
  const ESC_HINT = 'Press escape again to clear the input'
  const PRESS = '\x1b[<0;{X};{Y}M'
  const MOVE = '\x1b[<32;{X};{Y}M'
  const RELEASE = '\x1b[<0;{X};{Y}m'
  const opening = (text: string): Record<string, unknown>[] => [
    { atTick: 80, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r' },
    { atTick: 160, awaitText: 'Type a prompt', minTick: 5, awaitStableTicks: 2, requireAwait: true, data: text },
  ]
  const mark = (label: string, ticks = 5): Record<string, unknown> => ({ afterPrevTicks: ticks, data: '', mark: label })
  const aim = (needle: string, dx: number, data: string, ticks = 4): Record<string, unknown> => ({
    afterPrevTicks: ticks,
    targetText: needle,
    targetDx: dx,
    data,
  })

  const capture = (
    tag: string,
    size: { cols: number; rows: number },
    text: string,
    copyOnSelect: boolean,
    sends: Record<string, unknown>[],
  ): Capture | null => {
    const home = seededHome(`home-${tag}`, copyOnSelect)
    const gridPath = join(scratch, `${tag}.json`)
    const cfgPath = join(scratch, `${tag}-cfg.json`)
    writeFileSync(
      cfgPath,
      JSON.stringify({
        argv: [nodeBin, DIST, '--chat'],
        cwd: project,
        sends: [...opening(text), ...sends],
        total: 300,
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
      timeout: vshotBudgetMs(150_000),
    })
    if (res.status !== 0 || !existsSync(gridPath)) {
      check(`${tag}: the capture ran`, false, (res.stderr ?? '').slice(-400))
      return null
    }
    const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as { marks?: Mark[] }
    return { marks: new Map((payload.marks ?? []).map(m => [m.label, m])) }
  }

  const rowText = (grid: Cell[][], y: number): string => (grid[y] ?? []).map(c => c.c).join('')
  const textOf = (grid: Cell[][]): string => grid.map((_, y) => rowText(grid, y)).join('\n')
  const rowOf = (grid: Cell[][], needle: string): number => grid.findIndex((_, y) => rowText(grid, y).includes(needle))
  const frameOf = (grid: Cell[][]): { top: number; bottom: number } => {
    let top = -1
    let bottom = -1
    for (let y = 0; y < grid.length; y++) {
      const row = rowText(grid, y).trimStart()
      if (row.startsWith('╭')) top = y
      if (row.startsWith('╰')) bottom = y
    }
    return { top, bottom }
  }
  const sameFrame = (a: Mark, b: Mark): boolean => {
    const fa = frameOf(a.grid)
    const fb = frameOf(b.grid)
    return fa.top !== -1 && fa.top === fb.top && fa.bottom === fb.bottom
  }
  const frameWords = (m: Mark): string => {
    const f = frameOf(m.grid)
    return `rows ${f.top}..${f.bottom}`
  }

  const noticeLeg = (
    at: string,
    tag: string,
    got: Capture | null,
    notice: string,
    anchor: RegExp,
    marks: { before: string; showing: string; after: string },
  ): void => {
    if (!got) return
    const before = got.marks.get(marks.before)
    const showing = got.marks.get(marks.showing)
    const after = got.marks.get(marks.after)
    check(`${at} ${tag}: the three marks landed`, before !== undefined && showing !== undefined && after !== undefined)
    if (!before || !showing || !after) return
    check(`${at} ${tag}: the notice is on screen at its moment`, textOf(showing.grid).includes(notice))
    const row = rowOf(showing.grid, notice)
    const line = row === -1 ? '' : rowText(showing.grid, row)
    check(
      `${at} ${tag}: the notice rides the hint row, after the hints`,
      row !== -1 && line.search(anchor) !== -1 && line.search(anchor) < line.indexOf(notice),
      JSON.stringify(line.trimEnd()),
    )
    check(
      `${at} ${tag}: the composer's frame does not move while the notice shows`,
      sameFrame(before, showing),
      `${frameWords(before)} → ${frameWords(showing)}`,
    )
    check(
      `${at} ${tag}: the hint row sits right under the composer before, during and after`,
      [before, showing, after].every(m => anchor.test(rowText(m.grid, frameOf(m.grid).bottom + 1))),
    )
    check(`${at} ${tag}: the notice leaves after its moment`, !textOf(after.grid).includes(notice))
    check(`${at} ${tag}: …and the frame is where it was`, sameFrame(before, after), `${frameWords(before)} → ${frameWords(after)}`)
  }

  for (const size of [
    { cols: 120, rows: 40 },
    { cols: 82, rows: 17 },
  ]) {
    const at = `${size.cols}x${size.rows}`
    const anchor = size.cols >= 100 ? /for commands \+ files/ : /\d sessions? on|S:\d/
    console.log(`\n  ── ${at}`)

    const copy = capture(`copy-${at}`, size, T1, true, [
      mark('typed'),
      aim('quick brown', 0, PRESS),
      aim('quick brown', 5, MOVE, 2),
      aim('quick brown', 10, MOVE, 2),
      aim('quick brown', 10, RELEASE, 2),
      mark('receipt', 2),
      mark('later', 14),
    ])
    noticeLeg(at, 'copy receipt', copy, RECEIPT, anchor, { before: 'typed', showing: 'receipt', after: 'later' })

    const esc = capture(`esc-${at}`, size, T1, false, [
      mark('typed'),
      { afterPrevTicks: 3, data: '\x1b' },
      mark('notice', 2),
      mark('later', 18),
    ])
    noticeLeg(at, 'escape hint', esc, ESC_HINT, anchor, { before: 'typed', showing: 'notice', after: 'later' })
  }
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` ❌ prove-composer-notice-row: ${failures} failure(s)`)
  process.exit(1)
}
console.log(' ✅ composer-notice-row — the receipt and the hints share one row · the composer never moves for a notice')
