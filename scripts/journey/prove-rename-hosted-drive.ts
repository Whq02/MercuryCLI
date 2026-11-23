#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { vshotBudgetMs, resolveCaptureDriver } from '../lib/captureDriver.ts'
import { BOOT_FACE_READY } from '../lib/bootFace.ts'
import { childEnv, startFixture } from '../daemon/dupline-world.ts'
import { keyHintLabel } from '../../src/screen/widgets/keyHintLabel.ts'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at < 0 ? undefined : process.argv[at + 1]
}
const BIN = argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs')
const FRAMES = argAfter('--frames')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
const vendoredNode = join(BIN, '../vendor/node/bin/node')
const NODE = existsSync(vendoredNode) ? vendoredNode : 'node'
if (!existsSync(BIN)) throw new Error('dist/mercury.mjs missing — run the build first')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') throw new Error(`capture driver unavailable: ${driver.kind}`)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

type Cell = { c: string; fg: string; bg: string; bold: boolean; rev: boolean }
type Grid = Cell[][]
type Payload = { grid: Grid; marks?: Array<{ label: string; grid: Grid }>; endReason: string }
const gridText = (grid: Grid): string[] => grid.map(row => row.map(cell => cell.c).join(''))
const titleRow = (grid: Grid): string => gridText(grid).find(row => row.includes('✶ VIEW')) ?? ''
const composer = (grid: Grid): Grid => grid.slice(grid.length - 5, grid.length - 2)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'rename-hosted-'))

async function capture(cols: number, rows: number): Promise<Record<string, Grid>> {
  const tag = `${cols}x${rows}`
  const world = join(scratch, tag)
  const cwd = join(world, 'fixture-cwd')
  const home = join(world, 'home')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(home)
  seedFirstRun(home, [cwd])
  const fixture = await startFixture(join(world, 'wire.jsonl'), 1, 1)
  const env: NodeJS.ProcessEnv = {
    ...childEnv(home, fixture.port),
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    MERCURY_CRITTER: 'clam',
    MERCURY_AWAY_SUMMARY: '0',
    USER: 'sam', TERM: 'xterm-256color', TERM_PROGRAM: 'vscode',
  }
  for (const key of ['NODE_ENV', 'MERCURY_DEMO', 'CI', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_API_KEY_FILE_DESCRIPTOR', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN']) delete env[key]
  const cfgPath = join(world, 'cfg.json')
  const outPath = join(world, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({
    argv: [NODE, BIN, '--chat'], cwd, cols, rows, total: 400,
    sends: [
      { data: '\r', awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, requireAwait: true, minTick: 20, awaitSettleTicks: 5 },
      { data: '/rename roomie\r', awaitText: 'ready ·', targetText: keyHintLabel('⇧← back'), requireAwait: true, awaitSettleTicks: 8, mark: 'idle' },
      { data: 'hello fixture\r', awaitText: 'Renamed this session to roomie', requireAwait: true, awaitSettleTicks: 8, mark: 'renamed' },
      { data: '', awaitText: 'heard: hello fixture', requireAwait: true, awaitSettleTicks: 6 },
      { data: '/rename a-longer-session-title\r', awaitText: 'ready ·', requireAwait: true, awaitSettleTicks: 6, mark: 'after-turn' },
      { data: '/rename x\r', awaitText: 'Renamed this session to a-longer-session-title', requireAwait: true, awaitSettleTicks: 8, mark: 'long-title' },
      { data: '', awaitText: 'Renamed this session to x', requireAwait: true, awaitSettleTicks: 8, mark: 'short-title' },
    ],
    readyText: ['Renamed this session to x'], readySettleTicks: 4, out: outPath,
  }))
  try {
    const stderr: string[] = []
    const child = spawn(driver.python, [VSHOT, cfgPath], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(150_000))
    child.stderr.on('data', chunk => stderr.push(String(chunk)))
    const code = await new Promise<number>(resolve => child.once('close', value => resolve(value ?? 1)))
    clearTimeout(deadline)
    if (code !== 0 || !existsSync(outPath)) throw new Error(`${tag}: vshot exit ${code}: ${stderr.join('').slice(-600)}`)
    const payload = JSON.parse(readFileSync(outPath, 'utf8')) as Payload
    const marks = Object.fromEntries((payload.marks ?? []).map(mark => [mark.label, mark.grid]))
    check(`${tag}: a real turn reached the fixture`, fixture.wire().some(row => row.kind === 'request'),
      'the chat started by the capture sent no model request to the fixture; rerun with --frames <dir> and read the saved grids')
    if (FRAMES !== undefined) {
      mkdirSync(FRAMES, { recursive: true })
      for (const [name, grid] of Object.entries(marks)) {
        const base = join(FRAMES, `${tag}-${name}`)
        writeFileSync(`${base}.json`, JSON.stringify({ cols, rows, grid }))
        writeFileSync(`${base}.txt`, gridText(grid).join('\n') + '\n')
      }
    }
    return marks
  } finally {
    fixture.kill()
  }
}


console.log('/rename keeps the hosted composer and names the session — real bundle, PTY')
try {
  for (const [cols, rows] of [[178, 51], [120, 40]] as const) {
    const marks = await capture(cols, rows)
    const idle = marks.idle!
    check(`${cols}×${rows}: R1 the idle chat paints no title row (the name lives in the terminal title, the concourse and /sessions)`, titleRow(idle) === '', 'the idle chat painted a row containing the VIEW title marker; the session name must not be drawn as a title row')
    const frame = composer(idle)
    check(`${cols}×${rows}: the initial composer is rounded`, frame[0]?.[0]?.c === '╭' && frame[2]?.[0]?.c === '╰' && frame[1]?.[0]?.c === '│', 'the idle composer is not drawn with rounded corners; rerun with --frames <dir> and read the idle grid')
    for (const [mark, name] of [['renamed', 'roomie'], ['long-title', 'a-longer-session-title'], ['short-title', 'x']] as const) {
      const grid = marks[mark]!
      check(`${cols}×${rows}: R2 the rename paints no title row either`, titleRow(grid) === '', `after ${mark} a title row was painted; /rename (src/commands/rename/rename.ts) must not add one`)
      check(`${cols}×${rows}: R3 the receipt carries ${name}`, gridText(grid).some(row => row.includes(`Renamed this session to ${name}`)),
        'the receipt text from onDone in src/commands/rename/rename.ts did not reach the screen; rerun with --frames <dir>')
      check(`${cols}×${rows}: all three composer rows stay cell-identical after ${mark}`, same(composer(grid), frame), `the composer rows changed after ${mark}; /rename (src/commands/rename/rename.ts) must leave the composer untouched; rerun with --frames <dir> to compare`)
    }
    check(`${cols}×${rows}: the turn leaves the rounded composer in place`, same(composer(marks['after-turn']!), frame), 'the composer rows changed after a turn; rerun with --frames <dir> and compare the after-turn grid with idle')
  }
} catch (error) {
  check('the journey completed', false, `${String(error)} — a build is needed at dist/mercury.mjs or pass --dist; a vshot failure carries its stderr tail in the error text`)
} finally {
  if (failures === 0) rmSync(scratch, { recursive: true, force: true })
  else console.log(`scratch kept: ${scratch}`)
}
console.log(`prove-rename-hosted-drive: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
