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
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const bundleArg = arg('--bundle')
const DIST = bundleArg !== undefined ? realpathSync(bundleArg) : join(ROOT, 'dist', 'mercury.mjs')
const framesDir = arg('--frames')
if (framesDir !== undefined) mkdirSync(framesDir, { recursive: true })

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
  const handler = readFileSync('src/components/ScrollKeybindingHandler.tsx', 'utf8')
  check(
    'the notifications column paints no transient row',
    !column.includes('{footerNoticeLine(current.text)}') && !column.includes("'jsx' in current ? ("),
  )
  check(
    'the hint row reads the current notice and hands it the whole row: the hint set steps aside while a notice stands and never shares its text node',
    footer.includes('const currentNotice = useAppState((state: AppState) => state.notifications.current)') &&
      footer.includes('const noticeStands = noticeText !== null || noticeBlock !== null') &&
      footer.includes('const hintsShow = !vimInsert && !noticeStands && parts.length > 0') &&
      !footer.includes('parts.push(noticeText)') &&
      /\{noticeText !== null \? \(\s*\n\s*<Box flexShrink=\{1\} minWidth=\{0\} flexWrap="wrap" height=\{1\} overflow="hidden">/.test(footer),
  )
  check(
    "the hint row's notice box wraps with one row of height, so a notice's detail is its own text node that rides after the words only where the row has room for it whole, and steps aside whole where it does not",
    footer.includes('const noticeDetail = noticeText !== null ? noticeRowDetail(currentNotice) : null') &&
      /\{noticeDetail !== null \? \(\s*\n\s*<Text dimColor wrap="truncate-end">\s*\n\s*<Text color=\{tokens\.textMuted\}> · <\/Text>\s*\n\s*\{noticeDetail\}/.test(footer),
  )
  check(
    'the idle hint keeps its words and its click road, and steps aside while a notice stands',
    footer.includes('for commands + files') &&
      /onClick=\{\(\) => \{[\s\S]{0,240}requestCommandDispatch\('\/help'\)/.test(footer) &&
      /const idleHintShows =\s*\n\s*parts\.length === 0 && !showTasksPill && hintsEnabled && !showPrBadge && !noticeStands/.test(footer),
  )
  check(
    "the compact layout's count line keeps the way back beside a text notice: the counts step aside while it stands and return when it clears, the notice is cut to the columns before the hint with two blank columns between, and the setting off hands the notice the whole row",
    summary.includes('const noticeText = noticeRowText(currentNotice)') &&
      summary.includes('const wayBackStays = noticeText !== null && getSettingsSnapshot().settings.context?.wayBack !== false') &&
      summary.includes("const hint = noticeText !== null && !wayBackStays ? '' : compactSummaryHint({ focused, vimInsert, escHint: escRungHint(rung), stripHint })") &&
      summary.includes("const noticeColumns = wayBackStays && hint !== '' ? Math.max(0, columns - hintWidth - 1) : null") &&
      summary.includes('marginLeft={wayBackStays ? 2 : 1}') &&
      summary.includes('{noticeText !== null ? noticeText : compactWorkSummaryText(counts, Math.max(0, columns - hintWidth))}') &&
      !summary.includes('noticeWidth'),
  )
  check(
    "the compact count line's box wraps with one row of height and paints the notice's detail as a second text node in the counts' ink, after the house seam, only where the columns before the hint hold both whole",
    summary.includes('const noticeDetail = noticeText !== null ? noticeRowDetail(currentNotice) : null') &&
      /minWidth=\{0\} flexWrap="wrap" height=\{1\} overflow="hidden" onClick=\{onFocus\}>/.test(summary) &&
      /\{noticeDetail !== null \? \(\s*\n\s*<Text wrap="truncate-end" \{\.\.\.ink\}>\s*\n\s*\{' · '\}\s*\n\s*\{noticeDetail\}/.test(summary),
  )
  check(
    "the copy receipt is raised from the clipboard service's own words for the predicted road, and the unsettled correction from the same owner",
    handler.includes('...copyReceipt(path),') && handler.includes("...copyReceipt('unsettled'),") && !handler.includes('${where}'),
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
  const { footerNoticeLine, noticeBlockRows, noticeRowBlock, noticeRowDetail, noticeRowText } = await import('../../src/components/PromptInput/Notifications.tsx')
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
  const hasDetail = typeof noticeRowDetail === 'function'
  check('the notice row reads a detail beside the words (noticeRowDetail)', hasDetail)
  if (hasDetail) {
    const detailed = noticeRowDetail({ key: 'k', priority: 'immediate', text: 'Copied to clipboard via terminal escape', detail: 'check the terminal' })
    check("a text notice's detail is its own row part, the words untouched", detailed === 'check the terminal' && noticeRowText({ key: 'k', priority: 'immediate', text: 'Copied to clipboard via terminal escape', detail: 'check the terminal' }) === 'Copied to clipboard via terminal escape', JSON.stringify(detailed))
    const colouredDetail = noticeRowDetail({ key: 'k', priority: 'high', text: 'failed', detail: 'why', color: 'error' })
    check("a coloured notice's detail wears the same colour", React.isValidElement(colouredDetail) && colouredDetail.type === Text && (colouredDetail.props as { color?: string }).color === 'error')
    check('a notice without a detail, a jsx notice and no notice carry none', noticeRowDetail({ key: 'k', priority: 'immediate', text: 'Copied to clipboard' }) === null && noticeRowDetail({ key: 'k', priority: 'immediate', jsx: textJsx }) === null && noticeRowDetail(null) === null)
  }
  const threeRows = React.createElement(Box, { flexDirection: 'column' }, ['one', 'two', 'three'].map(row => React.createElement(Text, { key: row }, row)))
  check('a block notice asks the footer for as many rows as it stacks; a text or Text-shaped notice asks for none', noticeBlockRows({ key: 'k', priority: 'high', jsx: threeRows }) === 3 && noticeBlockRows({ key: 'k', priority: 'high', jsx: boxJsx }) === 1 && noticeBlockRows({ key: 'k', priority: 'immediate', jsx: textJsx }) === 0 && noticeBlockRows({ key: 'k', priority: 'low', text: 'a\nb\nc' }) === 0 && noticeBlockRows(null) === 0)
  const fiveRows = React.createElement(Box, { flexDirection: 'column' }, ['one', 'two', 'three', 'four', 'five'].map(row => React.createElement(Text, { key: row }, row)))
  const capped = noticeRowBlock({ key: 'k', priority: 'high', jsx: fiveRows })
  const cappedRows = React.isValidElement(capped) ? React.Children.toArray((capped.props as { children?: React.ReactNode }).children) : []
  check('a block taller than three rows keeps its first two rows and its last, the action row last', noticeBlockRows({ key: 'k', priority: 'high', jsx: fiveRows }) === 3 && cappedRows.length === 3 && cappedRows.every((row, i) => React.isValidElement(row) && (row.props as { children?: unknown }).children === ['one', 'two', 'five'][i]))
}

section('§3 the copy receipt per road — a whole sentence beside the way back at 80 columns on both platforms, the detail only where the row holds it')
type Road = 'native' | 'tmux-buffer' | 'osc52' | 'unsettled'
type Platform = 'macos' | 'linux'
const HOST: Platform = process.platform === 'darwin' ? 'macos' : 'linux'
const RECEIPT = 'Copied to clipboard'
const HOSTED_RED_ROW = 'Copied to clipboard (terminal escape transfer — check the term…  shift+← boot face'
const OLD_ESCAPE_SENTENCE = "Copied to clipboard (terminal escape transfer — check the terminal's clipboard settings if pasting fails)"
const { copyReceipt } = await import('../../src/ink/termio/osc.ts')
const { compactWorkSummaryText } = await import('../../src/components/tasks/useFocusedWork.ts')
const { keyHintLabel } = await import('../../src/components/mercury-ui/keyHintLabel.ts')
const { stringWidth } = await import('../../src/ink/stringWidth.ts')
const { footerNoticeLine } = await import('../../src/components/PromptInput/Notifications.tsx')
const COMPACT_COUNTS = { sessionsOn: 1, monitorsHere: 0, agentsHere: 0, samples: 0 }
const compactHint = (platform: Platform): string => keyHintLabel('⇧← boot face', platform)
const COMPACT_HINT = compactHint(HOST)
const compactSummary = (cols: number, platform: Platform = HOST): string =>
  compactWorkSummaryText(COMPACT_COUNTS, Math.max(0, cols - (stringWidth(compactHint(platform)) + 1)))
const compactNoticeRow = (notice: string, cols: number, platform: Platform = HOST, detail?: string): string => {
  const hint = compactHint(platform)
  const keep = cols - 2 - stringWidth(hint)
  const words = footerNoticeLine(notice)
  const line = detail !== undefined && stringWidth(`${words} · ${detail}`) <= keep ? `${words} · ${detail}` : words
  const cut = stringWidth(line) <= keep ? line : `${line.slice(0, keep - 1)}…`
  return cut.padEnd(cols - stringWidth(hint)) + hint
}
const noticeRowHolds = (line: string, notice: string, platform: Platform = HOST, detail?: string): boolean =>
  line === compactNoticeRow(notice, stringWidth(line), platform, detail)
const wideNoticeRow = (notice: string, detail?: string): string => (detail === undefined ? notice : `${notice} · ${detail}`)
const receiptOf = (road: Road): { text: string; detail?: string } => (typeof copyReceipt === 'function' ? copyReceipt(road) : { text: RECEIPT })
const hasRoads = typeof copyReceipt === 'function'
check('the clipboard service owns the receipt words per road (copyReceipt)', hasRoads)
{
  const native = receiptOf('native')
  check('the native road (macOS, pbcopy) keeps its short receipt, no detail', native.text === RECEIPT && native.detail === undefined, JSON.stringify(native))
  for (const road of ['native', 'tmux-buffer', 'osc52'] as const) {
    check(`the ${road} road's receipt is the ONE receipt, qualified by its road`, receiptOf(road).text.startsWith(RECEIPT), JSON.stringify(receiptOf(road).text))
  }
  for (const road of ['native', 'tmux-buffer', 'osc52', 'unsettled'] as const) {
    const words = receiptOf(road)
    for (const platform of ['macos', 'linux'] as const) {
      const budget = 80 - 2 - stringWidth(compactHint(platform))
      check(
        `${road} · ${platform}: the receipt's sentence fits whole in the ${budget} columns before the way back at 80 columns`,
        stringWidth(words.text) <= budget,
        `${stringWidth(words.text)} columns: ${JSON.stringify(words.text)}`,
      )
    }
  }
  check(
    'the idle 82-column count row keeps its whole count line beside the way back on both platforms (nothing of it changes while no notice stands)',
    compactSummary(82, 'macos') === '1 session on · 0 monitors here · 0 agents here' && compactSummary(82, 'linux') === '1 session on · 0 monitors here · 0 agents here',
    `macOS ${JSON.stringify(compactSummary(82, 'macos'))} · Linux ${JSON.stringify(compactSummary(82, 'linux'))}`,
  )
  for (const cols of [80, 82]) {
    for (const road of ['native', 'tmux-buffer', 'osc52', 'unsettled'] as const) {
      const words = receiptOf(road)
      const rows = (['macos', 'linux'] as const).map(platform => ({ platform, row: compactNoticeRow(words.text, cols, platform, words.detail) }))
      check(
        `${cols} columns · ${road}: the receipt row on both platforms is the whole sentence, no ellipsis, the detail after the seam only where both fit, two blank columns, then the way back at the row's right end`,
        rows.every(({ platform, row }) => {
          const hint = compactHint(platform)
          const keep = cols - 2 - stringWidth(hint)
          const detailFits = words.detail !== undefined && stringWidth(`${words.text} · ${words.detail}`) <= keep
          const body = detailFits ? `${words.text} · ${words.detail}` : words.text
          return row.startsWith(body) && !row.includes('…') && row.slice(stringWidth(body)).startsWith('  ') && row.endsWith(hint) && stringWidth(row) === cols && !row.startsWith(' · ') && (detailFits || !row.includes(' · '))
        }),
        rows.map(({ platform, row }) => `${platform} ${JSON.stringify(row)}`).join(' · '),
      )
    }
  }
  const escape = receiptOf('osc52')
  const oldRow = (platform: Platform): string => compactNoticeRow(OLD_ESCAPE_SENTENCE, 82, platform)
  check(
    "the hosted red — the escape transfer's old sentence cut mid-word before the way back at 82 columns — is the row the old law modelled, and no longer satisfies the row on either platform",
    oldRow('linux') === HOSTED_RED_ROW && !noticeRowHolds(oldRow('linux'), escape.text, 'linux', escape.detail) && !noticeRowHolds(oldRow('macos'), escape.text, 'macos', escape.detail),
    `Linux ${JSON.stringify(oldRow('linux'))} · macOS ${JSON.stringify(oldRow('macos'))}`,
  )
  check(
    'the shipped shape — the notice alone across the row, cut at the width, the way back gone — no longer satisfies the row',
    !noticeRowHolds(RECEIPT.padEnd(82), RECEIPT, 'macos') && !noticeRowHolds(`${wideNoticeRow(escape.text, escape.detail).slice(0, 81)}…`, escape.text, 'linux', escape.detail),
  )
}

section('§4 pty — the real binary on each road: the receipt and the escape hint take the hint row whole, the hints return, the composer never moves')
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
  type DrivenRoad = 'native' | 'osc52'
  const ROADS: readonly DrivenRoad[] = process.platform === 'darwin' ? ['native', 'osc52'] : ['osc52']
  const childEnv = (home: string, road: DrivenRoad): NodeJS.ProcessEnv => {
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
    if (road === 'osc52' && process.platform === 'darwin') env.SSH_CONNECTION = '10.0.0.2 51000 10.0.0.1 22'
    mkdirSync(env.HOME!, { recursive: true })
    return env
  }

  type Cell = { c: string; bg: string; rev: boolean }
  type Cursor = { x: number; y: number }
  type Mark = { label: string; grid: Cell[][]; cursor: Cursor }
  type Capture = { marks: Map<string, Mark> }

  const T1 = 'the quick brown fox jumps over the lazy dog'
  const ESC_HINT = 'Press escape again to clear the input'
  const PRESS = '\x1b[<0;{X};{Y}M'
  const MOVE = '\x1b[<32;{X};{Y}M'
  const RELEASE = '\x1b[<0;{X};{Y}m'
  const opening = (text: string): Record<string, unknown>[] => [
    { atTick: 80, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r' },
    { atTick: 160, awaitText: 'Type a prompt', minTick: 5, awaitStableTicks: 2, requireAwait: true, data: text },
  ]
  const mark = (label: string, ticks = 5): Record<string, unknown> => ({ afterPrevTicks: ticks, data: '', mark: label })
  const markWhen = (label: string, needle: string): Record<string, unknown> => ({ afterPrevTicks: 3, awaitText: needle, awaitSettleTicks: 2, requireAwait: true, data: '', mark: label })
  const aim = (needle: string, dx: number, data: string, ticks = 4): Record<string, unknown> => ({
    afterPrevTicks: ticks,
    targetText: needle,
    targetDx: dx,
    data,
  })

  const capture = (
    tag: string,
    road: DrivenRoad,
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
      env: childEnv(home, road),
      cwd: project,
      encoding: 'utf8',
      timeout: vshotBudgetMs(150_000),
    })
    if (res.status !== 0 || !existsSync(gridPath)) {
      check(`${tag}: the capture ran`, false, (res.stderr ?? '').slice(-400))
      return null
    }
    const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as { marks?: Mark[] }
    const marks = new Map((payload.marks ?? []).map(m => [m.label, m]))
    if (framesDir !== undefined) {
      for (const [label, m] of marks) {
        writeFileSync(join(framesDir, `${tag}-${label}.txt`), `${tag} · ${label} · ${size.cols}x${size.rows}\n${m.grid.map(row => row.map(c => c.c).join('').trimEnd()).join('\n')}\n`)
      }
    }
    return { marks }
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
    notice: { needle: string; text: string; detail?: string },
    anchor: RegExp | { idle: string },
    marks: { before: string; showing: string; after: string },
  ): void => {
    if (!got) return
    const before = got.marks.get(marks.before)
    const showing = got.marks.get(marks.showing)
    const after = got.marks.get(marks.after)
    check(`${at} ${tag}: the three marks landed`, before !== undefined && showing !== undefined && after !== undefined)
    if (!before || !showing || !after) return
    const row = rowOf(showing.grid, notice.needle)
    const line = row === -1 ? '' : rowText(showing.grid, row)
    check(`${at} ${tag}: the notice is on screen at its moment, its sentence whole`, textOf(showing.grid).includes(notice.text), JSON.stringify(line.trimEnd()))
    if (anchor instanceof RegExp) {
      check(
        `${at} ${tag}: the notice takes the hint row whole — its sentence leads the row, its detail rides after the seam where the row holds both, and the standing hints are gone while it stands`,
        row !== -1 && line.trimEnd() === wideNoticeRow(notice.text, notice.detail) && line.search(anchor) === -1 && !line.includes('for shortcuts'),
        JSON.stringify(line.trimEnd()),
      )
    } else {
      check(
        `${at} ${tag}: the notice leads the count row as a whole sentence, the detail only where the columns before the hint hold both, the counts step aside and the way back keeps the row's right end`,
        row !== -1 && noticeRowHolds(line, notice.text, HOST, notice.detail),
        JSON.stringify(line.trimEnd()),
      )
    }
    check(
      `${at} ${tag}: the composer's frame does not move while the notice shows`,
      sameFrame(before, showing),
      `${frameWords(before)} → ${frameWords(showing)}`,
    )
    const underComposer = (m: Mark): string => rowText(m.grid, frameOf(m.grid).bottom + 1)
    check(
      `${at} ${tag}: the hint row sits right under the composer before, during and after — the hints (the counts as far as they have settled, the way back) before and after, the notice in the counts' place while it stands`,
      anchor instanceof RegExp
        ? anchor.test(underComposer(before)) && anchor.test(underComposer(after)) && underComposer(showing).startsWith(notice.text)
        : /^\d+ sessions? on · /.test(underComposer(before)) && underComposer(before).trimEnd().endsWith(COMPACT_HINT) && underComposer(after).startsWith(anchor.idle) && underComposer(after).trimEnd().endsWith(COMPACT_HINT) && noticeRowHolds(underComposer(showing), notice.text, HOST, notice.detail),
      [before, showing, after].map(m => JSON.stringify(underComposer(m).trimEnd())).join(' → '),
    )
    check(`${at} ${tag}: the notice leaves after its moment`, !textOf(after.grid).includes(notice.needle))
    check(`${at} ${tag}: …and the frame is where it was`, sameFrame(before, after), `${frameWords(before)} → ${frameWords(after)}`)
  }

  const sizes = [
    { cols: 120, rows: 40 },
    { cols: 82, rows: 17 },
    ...(framesDir !== undefined ? [{ cols: 178, rows: 51 }] : []),
  ]
  for (const size of sizes) {
    const at = `${size.cols}x${size.rows}`
    const wide = size.cols >= 100
    const expectFor = (): RegExp | { idle: string } =>
      wide ? /for commands \+ files/ : { idle: compactSummary(size.cols) }
    console.log(`\n  ── ${at}`)

    for (const road of ROADS) {
      const words = receiptOf(road)
      const copy = capture(`copy-${road}-${at}`, road, size, T1, true, [
        markWhen('typed', T1),
        aim('quick brown', 0, PRESS),
        aim('quick brown', 5, MOVE, 2),
        aim('quick brown', 10, MOVE, 2),
        aim('quick brown', 10, RELEASE, 2),
        markWhen('receipt', RECEIPT),
        mark('later', road === 'native' ? 14 : 26),
      ])
      noticeLeg(at, `copy receipt · ${road} road`, copy, { needle: RECEIPT, text: words.text, ...(words.detail !== undefined ? { detail: words.detail } : {}) }, expectFor(), { before: 'typed', showing: 'receipt', after: 'later' })
    }

    const esc = capture(`esc-${at}`, ROADS[0]!, size, T1, false, [
      markWhen('typed', T1),
      { afterPrevTicks: 3, data: '\x1b' },
      markWhen('notice', ESC_HINT),
      mark('later', 18),
    ])
    noticeLeg(at, 'escape hint', esc, { needle: ESC_HINT, text: ESC_HINT }, expectFor(), { before: 'typed', showing: 'notice', after: 'later' })
  }
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` ❌ prove-composer-notice-row: ${failures} failure(s)`)
  process.exit(1)
}
console.log(' ✅ composer-notice-row — every road\'s copy receipt is a whole sentence beside the way back, its detail only where the row holds it · a notice takes the hint row for its moment, the hints return after it · the composer never moves for a notice')
