#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const root = resolve(arg('--root') ?? join(import.meta.dir, '../..'))
const dist = resolve(arg('--dist') ?? join(root, 'dist/mercury.mjs'))
const output = realpathSync(resolve(arg('--output') ?? mkdtempSync(join(tmpdir(), 'local-result-band-'))))
mkdirSync(output, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
const { seedFirstRun } = await import(join(root, 'scripts/lib/firstRunSeed.ts'))
const { encodeSeedTranscript } = await import(join(root, 'scripts/lib/seedTranscript.ts'))
const { sanitizePath } = await import(join(root, 'src/utils/sessionStoragePortable.ts'))
const { resolveCaptureDriver, captureEngineEntry, vshotBudgetMs } = await import(join(root, 'scripts/lib/captureDriver.ts'))
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') throw new Error(driver.remedy)

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const LAST_LINE = 'this bullet is the last line of the long result'
const WORDS = ['the', 'transcript', 'keeps', 'every', 'row', 'of', 'a', 'long', 'local', 'result', 'painted', 'where', 'its', 'layout', 'reserved', 'it', 'without', 'an', 'empty', 'band', 'under', 'the', 'last', 'bullet', 'on', 'any', 'width', 'and', 'in', 'either', 'runtime']
function longResult(): string {
  let seed = 7
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed
  }
  const sections: string[] = []
  for (let s = 0; s < 12; s++) {
    const lines = [`Version 9.9.${12 - s}:`]
    for (let b = 0; b < 18; b++) {
      const count = 6 + (next() % 30)
      const words: string[] = []
      for (let w = 0; w < count; w++) words.push(WORDS[next() % WORDS.length]!)
      lines.push(`• ${words.join(' ')}`)
    }
    sections.push(lines.join('\n'))
  }
  return `${sections.join('\n\n')}\n• ${LAST_LINE}`
}

type Cell = { c: string }
type Mark = { label: string; grid: Cell[][]; atTick: number }
const textOf = (grid: Cell[][]): string[] => grid.map(row => row.map(cell => cell.c).join(''))

function paneOf(lines: string[]): { left: number; right: number; bottom: number } | null {
  const header = lines.findIndex(line => line.includes('✶ SESSION'))
  if (header < 0) return null
  const left = lines[header]!.indexOf('│')
  const right = lines[header]!.lastIndexOf('│')
  let bottom = -1
  for (let i = header + 1; i < lines.length; i++) {
    const ch = lines[i]![left]
    if (ch === '╰') {
      bottom = i
      break
    }
  }
  if (left < 0 || right <= left || bottom < 0) return null
  return { left, right, bottom }
}

function readBand(lines: string[]): { needleRow: number; blankBelow: number; lastContentRow: number } | null {
  const pane = paneOf(lines)
  if (!pane) return null
  const inner = (i: number): string => lines[i]!.slice(pane.left + 1, pane.right)
  let lastContentRow = pane.bottom - 1
  if (inner(lastContentRow).includes('back to the bottom')) lastContentRow -= 1
  const needleRow = lines.findIndex((line, i) => i < pane.bottom && inner(i).includes(LAST_LINE))
  if (needleRow < 0) return { needleRow: -1, blankBelow: -1, lastContentRow }
  let blankBelow = 0
  for (let i = needleRow + 1; i <= lastContentRow; i++) if (inner(i).trim() === '') blankBelow++
  return { needleRow, blankBelow, lastContentRow }
}

async function drive(cols: number, rows: number): Promise<{ marks: Mark[]; exit: number | null; stderr: string; home: string }> {
  const home = realpathSync(mkdtempSync(join(output, `world-${cols}x${rows}-`)))
  const cwd = join(home, 'work')
  const config = join(home, 'config')
  mkdirSync(cwd)
  mkdirSync(config)
  process.env.MERCURY_CONFIG_DIR = config
  seedFirstRun(config, [cwd])
  writeFileSync(join(config, 'settings.json'), '{}')
  const sid = randomUUID()
  const timestamp = new Date().toISOString()
  const base = { isSidechain: false, entrypoint: 'cli', cwd, sessionId: sid, version: '1.0.0', gitBranch: 'main', timestamp }
  const seeded: Array<Record<string, unknown>> = []
  let parentUuid: string | null = null
  const add = (row: Record<string, unknown>): void => {
    const uuid = randomUUID()
    seeded.push({ ...base, ...row, uuid, parentUuid })
    parentUuid = uuid
  }
  add({ type: 'user', message: { role: 'user', content: 'Show the notes.' } })
  add({ type: 'assistant', message: { id: 'notes-reply', role: 'assistant', type: 'message', model: 'claude-opus-4-8', stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [{ type: 'text', text: 'Here they are.' }] } })
  add({ type: 'user', message: { role: 'user', content: `<local-command-stdout>${longResult()}</local-command-stdout>` } })
  const project = join(config, 'projects', sanitizePath(cwd))
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, `${sid}.jsonl`), encodeSeedTranscript(seeded, sid))
  const node = join(dirname(dist), 'vendor/node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmpdir(),
    TMP: tmpdir(),
    TEMP: tmpdir(),
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    MERCURY_CONFIG_DIR: config,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_HOME: join(home, 'product-home'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_AUTO_COMPACT: '0',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_AWAY_SUMMARY: '0',
    MERCURY_OPERATOR: 'sam',
    USER: 'sam',
    BROWSER: '/usr/bin/true',
    ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  }
  delete env.ANTHROPIC_AUTH_TOKEN
  const sends: Array<Record<string, unknown>> = [
    { data: '', awaitText: 'ype a prompt', requireAwait: true, minTick: 5, atTick: 250, awaitSettleTicks: 8, mark: 'bottom' },
  ]
  for (let i = 1; i <= 5; i++) {
    sends.push({ data: '\x1b[5~', afterPrevTicks: 3 })
    sends.push({ data: '', afterPrevTicks: 6, mark: `pageup${i}` })
  }
  const cfg = {
    argv: [existsSync(node) ? node : 'node', dist, '--resume', sid],
    cwd,
    cols,
    rows,
    out: join(output, `grid-${cols}x${rows}.json`),
    sends,
    total: 400,
  }
  const cfgPath = join(output, `capture-${cols}x${rows}.json`)
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
  const proc = spawn(driver.python, [captureEngineEntry(driver, root), cfgPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  proc.stdout.on('data', () => {})
  proc.stderr.on('data', chunk => { stderr += String(chunk) })
  const watchdog = setTimeout(() => proc.kill('SIGTERM'), vshotBudgetMs(200000))
  const exit = await new Promise<number | null>((done, reject) => { proc.once('exit', done); proc.once('error', reject) })
  clearTimeout(watchdog)
  const captured = existsSync(cfg.out) ? JSON.parse(readFileSync(cfg.out, 'utf8')) as { marks?: Mark[] } : {}
  for (const mark of captured.marks ?? []) writeFileSync(join(output, `${cols}x${rows}-${mark.label}.txt`), textOf(mark.grid).join('\n') + '\n')
  return { marks: captured.marks ?? [], exit, stderr, home }
}

console.log('── a long local result ends where its rows end (the built bundle) ──')
for (const [cols, rows] of [[120, 40], [177, 45]] as const) {
  const run = await drive(cols, rows)
  const size = `${cols}x${rows}`
  check(`[${size}] the capture ran to its marks`, run.exit === 0 && run.marks.length >= 1, `exit ${run.exit} marks ${run.marks.map(m => m.label).join(',')} ${run.stderr.slice(-200)}`)
  const bottom = run.marks.find(m => m.label === 'bottom')
  const band = bottom ? readBand(textOf(bottom.grid)) : null
  check(`[${size}] the transcript pane is on screen at the bottom of the chat`, band !== null)
  if (band) {
    check(`[${size}] the result's last line is painted on the pane's last row when the chat sits at the bottom`, band.needleRow >= 0 && band.needleRow === band.lastContentRow, band.needleRow < 0 ? 'the last line is not on screen: blank rows stand where it should be' : `last line on row ${band.needleRow}, the pane's last row is ${band.lastContentRow}`)
    check(`[${size}] no empty row stands between the last line and the pane's bottom`, band.needleRow >= 0 && band.blankBelow === 0, `${band.blankBelow} empty rows`)
  }
  if (band && band.needleRow < 0) {
    for (const mark of run.marks.filter(m => m.label.startsWith('pageup'))) {
      const later = readBand(textOf(mark.grid))
      if (later && later.needleRow >= 0) {
        console.log(`  [${size}] the last line appears only after ${mark.label.replace('pageup', '')} page-up(s), with ${later.blankBelow} empty rows under it before the pill`)
        break
      }
    }
  }
}
console.log(JSON.stringify({ output }))
console.log(failures === 0 ? '✅ local-result band: the row ends where its text ends' : `❌ local-result band: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
