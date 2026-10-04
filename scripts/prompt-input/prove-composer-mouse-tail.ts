#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import {
  INITIAL_STATE,
  type KeyParseState,
  type ParsedInput,
  parseMultipleKeypresses,
} from '../../src/ink/input/input-decoder.ts'
import { InputEvent } from '../../src/ink/events/input-event.ts'

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

const ESC = '\x1b'
const X10_HEAD = `${ESC}[MC)`
const X10_TAIL = '4'
const X10_WHOLE = X10_HEAD + X10_TAIL
const SGR_HEAD = `${ESC}[<35;9;`
const SGR_TAIL = '20M'

function drive(feeds: Array<string | null>): ParsedInput[] {
  let state: KeyParseState = { ...INITIAL_STATE }
  const out: ParsedInput[] = []
  for (const feed of feeds) {
    const [atoms, next] = parseMultipleKeypresses(state, feed)
    state = next
    out.push(...atoms)
  }
  return out
}
function typed(atoms: ParsedInput[]): string {
  return atoms
    .filter((a): a is Extract<ParsedInput, { kind: 'key' }> => a.kind === 'key')
    .map(a => new InputEvent(a).input)
    .join('')
}
function describe(atoms: ParsedInput[]): string {
  return JSON.stringify(
    atoms.map(a => (a.kind === 'key' ? `key:${a.name ?? ''}:${JSON.stringify(a.sequence ?? '')}` : a.kind === 'mouse' ? `mouse:${a.button}` : `response:${a.response.type}`)),
  )
}

section('§1 the decoder — a mouse report split at a flush never types its tail')
{
  const whole = drive([X10_WHOLE])
  check('an X10 motion report in one read is one mouse key and no text', typed(whole) === '' && whole.length === 1 && whole[0]!.kind === 'key' && whole[0]!.name === 'mouse', describe(whole))
  const noFlush = drive([X10_HEAD, X10_TAIL])
  check('an X10 report split across two reads with no flush between is still one mouse key', typed(noFlush) === '' && noFlush.length === 1, describe(noFlush))
  for (const [label, head, tail] of [
    ['after the x byte', X10_HEAD, X10_TAIL],
    ['after the button byte', `${ESC}[MC`, `)${X10_TAIL}`],
    ['after CSI M', `${ESC}[M`, `C)${X10_TAIL}`],
    ['after CSI', `${ESC}[`, `MC)${X10_TAIL}`],
  ] as const) {
    const split = drive([head, null, tail])
    check(`an X10 report split ${label} with a flush between types nothing`, typed(split) === '', describe(split))
  }
  const sgr = drive([SGR_HEAD, null, SGR_TAIL])
  check('the SGR twin of the same split types nothing (the resync law the X10 form must share)', typed(sgr) === '', describe(sgr))
  const afterwards = drive([X10_HEAD, null, X10_TAIL, 'ok'])
  check('the keystrokes after a swallowed tail arrive intact', typed(afterwards) === 'ok', describe(afterwards))
  const bailed = drive([X10_HEAD, null, 'ok'])
  check('a tail that never comes costs no typed letters beyond the report\'s own payload', typed(bailed) === 'k' || typed(bailed) === 'ok', describe(bailed))
  const whole2 = drive([X10_HEAD, null, `${X10_TAIL}${ESC}[M#)4`])
  check('the report behind a swallowed tail still parses as a mouse key', typed(whole2) === '' && whole2.some(a => a.kind === 'key' && a.name === 'mouse'), describe(whole2))
}

section('§2 pty — the real binary: the stray character on a route switch')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log(`  [SKIP] the pty leg needs the posix capture driver (${driver.kind})`)
} else if (!existsSync(DIST)) {
  console.log('  [SKIP] dist/mercury.mjs missing — the pty leg needs a build')
} else {
  const vendoredNode = join(ROOT, 'dist', 'vendor', 'node', 'bin', 'node')
  const nodeBin = existsSync(vendoredNode) ? vendoredNode : (Bun.which('node') ?? 'node')
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'composer-mouse-tail-')))
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

  const seededHome = (name: string): string => {
    const home = join(scratch, name)
    seedFirstRun(home, [project])
    return home
  }
  const childEnv = (home: string): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}`,
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
      'MERCURY_CONCOURSE', 'MERCURY_CONCOURSE_FIXTURE', 'NODE_ENV', 'CI', 'VSHOT_ACTIVE', 'MERCURY_CRITTER',
    ]) {
      delete env[key]
    }
    mkdirSync(env.HOME!, { recursive: true })
    return env
  }

  type Cell = { c: string }
  type Mark = { label: string; grid: Cell[][] }
  const opening: Record<string, unknown>[] = [
    { atTick: 80, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r' },
    { atTick: 160, awaitText: 'Type a prompt', minTick: 5, awaitStableTicks: 2, requireAwait: true, data: '' },
  ]
  const mark = (label: string): Record<string, unknown> => ({ afterPrevTicks: 4, data: '', mark: label })

  const capture = (tag: string, sends: Record<string, unknown>[]): Map<string, Mark> | null => {
    const home = seededHome(`home-${tag}`)
    const gridPath = join(scratch, `${tag}.json`)
    const cfgPath = join(scratch, `${tag}-cfg.json`)
    writeFileSync(
      cfgPath,
      JSON.stringify({
        argv: [nodeBin, DIST, '--chat'],
        cwd: project,
        sends: [...opening, ...sends],
        total: 200,
        stableTicks: 4,
        cols: 120,
        rows: 40,
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
    return new Map((payload.marks ?? []).map(m => [m.label, m]))
  }
  const rows = (grid: Cell[][]): string[] => grid.map(row => row.map(c => c.c || ' ').join(''))
  const composerRow = (grid: Cell[][]): string => {
    const found = rows(grid).filter(r => r.includes('❯'))
    return found.length > 0 ? found[found.length - 1]! : ''
  }
  const PLACEHOLDER = 'Type a prompt'
  const composerText = (grid: Cell[][]): string => {
    const row = composerRow(grid)
    const at = row.lastIndexOf('❯')
    if (at === -1) return ''
    const text = row.slice(at + 1).replace(/[│┃]\s*$/, '').trim()
    return text.startsWith(PLACEHOLDER) ? '' : text
  }

  const marks = capture('route-switch', [
    mark('idle'),
    { afterPrevTicks: 2, data: `${ESC}[1;2D` },
    { atTick: 190, awaitText: '⇧→ chat', minTick: 1, awaitSettleTicks: 2, requireAwait: true, data: `${ESC}[1;2C${X10_HEAD}` },
    { afterPrevTicks: 1, data: X10_TAIL },
    { atTick: 199, awaitText: '⇧← boot face', minTick: 1, awaitSettleTicks: 2, requireAwait: true, data: '' },
    mark('after-switch'),
    { afterPrevTicks: 2, data: X10_HEAD },
    { afterPrevTicks: 1, data: X10_TAIL },
    mark('after-split'),
    { afterPrevTicks: 2, data: 'ok' },
    mark('after-typing'),
  ])
  if (marks) {
    const idle = marks.get('idle')
    const afterSwitch = marks.get('after-switch')
    const afterSplit = marks.get('after-split')
    const afterTyping = marks.get('after-typing')
    check('the chat booted with an empty composer', idle !== undefined && composerText(idle.grid) === '' && rows(idle.grid).some(r => r.includes('Type a prompt')), idle ? composerRow(idle.grid) : 'no mark')
    check(
      'a mouse report split by a route switch leaves no stray character in the composer',
      afterSwitch !== undefined && composerText(afterSwitch.grid) === '',
      afterSwitch ? JSON.stringify(composerRow(afterSwitch.grid)) : 'no mark',
    )
    check(
      'a mouse report split at the flush deadline in the chat leaves no stray character in the composer',
      afterSplit !== undefined && composerText(afterSplit.grid) === '',
      afterSplit ? JSON.stringify(composerRow(afterSplit.grid)) : 'no mark',
    )
    check(
      'the keyboard still types after the swallowed tails',
      afterTyping !== undefined && composerText(afterTyping.grid) === 'ok',
      afterTyping ? JSON.stringify(composerRow(afterTyping.grid)) : 'no mark',
    )
  }
}

console.log(failures === 0 ? '\nALL LAWS HOLD' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
