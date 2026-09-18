#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
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
const output = realpathSync(resolve(arg('--output') ?? mkdtempSync(join(tmpdir(), 'update-notes-card-'))))
mkdirSync(output, { recursive: true })
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version
;(globalThis as Record<string, unknown>).MACRO = { VERSION: version }
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
const { seedFirstRun } = await import(join(root, 'scripts/lib/firstRunSeed.ts'))
const { encodeSeedTranscript } = await import(join(root, 'scripts/lib/seedTranscript.ts'))
const { sanitizePath } = await import(join(root, 'src/utils/sessionStoragePortable.ts'))
const { resolveCaptureDriver, captureEngineEntry, vshotBudgetMs } = await import(join(root, 'scripts/lib/captureDriver.ts'))
const { getAllReleaseNotes, earlierReleasesLine } = await import(join(root, 'src/utils/releaseNotes.ts'))
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') throw new Error(driver.remedy)

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const newestFirst = [...getAllReleaseNotes()].reverse()
if (newestFirst.length < 2) {
  console.log('the bundled changelog carries fewer than two releases; nothing to fold')
  process.exit(1)
}
const runningAt = newestFirst.findIndex(([v]) => v === version)
const shownAt = runningAt >= 0 ? runningAt : 0
const shown = newestFirst[shownAt]!
const earlier = newestFirst.filter((_, i) => i !== shownAt)
const oldest = earlier[earlier.length - 1]!
const head = (v: string): string => `Version ${v}:`
const shownFirstBullet = shown[1][0]!.slice(0, 40)
const oldestTail = oldest[1][oldest[1].length - 1]!.slice(-34)
const foldLine = earlierReleasesLine(earlier.length)
const foldTail = 'to expand)'

type Cell = { c: string }
type Mark = { label: string; grid: Cell[][]; atTick: number }
const textOf = (grid: Cell[][]): string => grid.map(row => row.map(cell => cell.c).join('')).join('\n')
const flat = (grid: Cell[][]): string => textOf(grid).replace(/\s+/g, ' ')

function world(tag: string): { home: string; cwd: string; config: string; env: NodeJS.ProcessEnv; node: string } {
  const home = realpathSync(mkdtempSync(join(output, `${tag}-`)))
  const cwd = join(home, 'work')
  const config = join(home, 'config')
  mkdirSync(cwd)
  mkdirSync(config)
  process.env.MERCURY_CONFIG_DIR = config
  seedFirstRun(config, [cwd])
  writeFileSync(join(config, 'settings.json'), '{}')
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
  return { home, cwd, config, env, node: existsSync(node) ? node : 'node' }
}

console.log('── /update-notes: the running release on the chat, the earlier releases behind the transcript key ──')

{
  const w = world('chat')
  const sid = randomUUID()
  const timestamp = new Date().toISOString()
  const base = { isSidechain: false, entrypoint: 'cli', cwd: w.cwd, sessionId: sid, version: '1.0.0', gitBranch: 'main', timestamp }
  const rows: Array<Record<string, unknown>> = []
  let parentUuid: string | null = null
  const add = (row: Record<string, unknown>): void => {
    const uuid = randomUUID()
    rows.push({ ...base, ...row, uuid, parentUuid })
    parentUuid = uuid
  }
  add({ type: 'user', message: { role: 'user', content: 'Say hello.' } })
  add({ type: 'assistant', message: { id: 'hello-reply', role: 'assistant', type: 'message', model: 'claude-opus-4-8', stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [{ type: 'text', text: 'Hello. What shall we work on?' }] } })
  const project = join(w.config, 'projects', sanitizePath(w.cwd))
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, `${sid}.jsonl`), encodeSeedTranscript(rows, sid))
  const cfg = {
    argv: [w.node, dist, '--resume', sid],
    cwd: w.cwd,
    cols: 120,
    rows: 60,
    out: join(output, 'chat-grid.json'),
    sends: [
      { data: '', awaitText: 'ype a prompt', requireAwait: true, minTick: 5, atTick: 250, awaitSettleTicks: 4, mark: 'ready' },
      { data: '/update-notes', afterPrevTicks: 3 },
      { data: '\r', awaitText: 'wait behind the transcript key', requireAwait: true, minTick: 2, atTick: 350, awaitSettleTicks: 5 },
      { data: '', awaitText: foldTail, requireAwait: true, minTick: 2, atTick: 550, awaitSettleTicks: 10, mark: 'card' },
      { data: '\x1b[5~', afterPrevTicks: 3 },
      { data: '', afterPrevTicks: 8, mark: 'card-up' },
      { data: '\x1b[1;3B', afterPrevTicks: 3 },
      { data: '\x0f', afterPrevTicks: 8 },
      { data: '', awaitText: oldestTail, requireAwait: true, minTick: 2, atTick: 700, awaitSettleTicks: 8, mark: 'pager' },
      { data: '\x0f', afterPrevTicks: 3 },
      { data: '', awaitText: 'ype a prompt', requireAwait: true, minTick: 2, atTick: 800, awaitSettleTicks: 6, mark: 'back' },
      { data: '/release-notes', afterPrevTicks: 3 },
      { data: '\r', awaitText: 'former name of /update-notes', requireAwait: true, minTick: 2, atTick: 900, awaitSettleTicks: 5 },
      { data: '', awaitText: '❯ /release-notes', requireAwait: true, minTick: 2, atTick: 1000, awaitSettleTicks: 14, mark: 'alias' },
    ],
    total: 1100,
  }
  const cfgPath = join(output, 'chat-capture.json')
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
  const proc = spawn(driver.python, [captureEngineEntry(driver, root), cfgPath], { env: w.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  proc.stdout.on('data', () => {})
  proc.stderr.on('data', chunk => { stderr += String(chunk) })
  const watchdog = setTimeout(() => proc.kill('SIGTERM'), vshotBudgetMs(260000))
  const exit = await new Promise<number | null>((done, reject) => { proc.once('exit', done); proc.once('error', reject) })
  clearTimeout(watchdog)
  const captured = existsSync(cfg.out) ? JSON.parse(readFileSync(cfg.out, 'utf8')) as { marks?: Mark[] } : {}
  const marks = new Map((captured.marks ?? []).map(mark => [mark.label, mark]))
  for (const mark of marks.values()) writeFileSync(join(output, `chat-${mark.label}.txt`), textOf(mark.grid) + '\n')
  check('the chat journey ran to its marks', exit === 0 && marks.has('alias'), `exit ${exit} marks ${[...marks.keys()].join(',')} ${stderr.slice(-240)}`)
  const card = marks.get('card') ? flat(marks.get('card')!.grid) : ''
  const cardUp = marks.get('card-up') ? flat(marks.get('card-up')!.grid) : ''
  const cardBoth = `${card} ${cardUp}`
  check(`the running release's section is painted (its head: ${head(shown[0])})`, cardBoth.includes(head(shown[0])) && cardBoth.includes(shownFirstBullet.replace(/\s+/g, ' ')))
  check(`the card's last line offers the earlier releases behind the key: "${foldLine} (… to expand)"`, card.includes(foldLine) && card.includes(foldTail))
  check('no earlier release is painted on the chat before the key', earlier.every(([v]) => !cardBoth.includes(head(v))))
  const pager = marks.get('pager') ? flat(marks.get('pager')!.grid) : ''
  check('the transcript key shows the earlier releases (the oldest section reaches its last line)', pager.includes(oldestTail.replace(/\s+/g, ' ')))
  check('the pager carries no fold line of its own', !pager.includes(foldLine))
  const alias = marks.get('alias') ? flat(marks.get('alias')!.grid) : ''
  check('/release-notes answers the same card', alias.includes(foldLine) && alias.includes(foldTail) && !/Unknown skill|is retired|not enabled/.test(alias))
}

console.log('── the headless road prints every release ──')
{
  const runHeadless = (command: string): string => {
    const w = world(`headless-${command.slice(1)}`)
    const res = spawnSync(w.node, [dist, '-p', command], { cwd: w.cwd, encoding: 'utf8', env: w.env, timeout: vshotBudgetMs(120000) })
    return res.stdout ?? ''
  }
  const printed = runHeadless('/update-notes')
  check('the headless run prints every release', newestFirst.every(([v]) => printed.includes(head(v))), `${(printed.match(/^Version /gm) ?? []).length} of ${newestFirst.length} heads`)
  check('the headless run carries no key line', !printed.includes('earlier release'))
  const aliasPrinted = runHeadless('/release-notes')
  check('the headless /release-notes prints the same text', aliasPrinted === printed && printed.length > 0)
}

console.log(JSON.stringify({ output }))
console.log(failures === 0 ? '✅ update-notes card: green' : `❌ update-notes card: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
