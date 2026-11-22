#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { paintsBootFaceReady } from '../lib/bootFace.ts'
import { posixPtyDriverOrSkip, vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { nodeBinPath } from '../lib/nodeBin.ts'
import { recordPty } from '../lib/ptyRecorder.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { untilAsync } from '../lib/untilAsync.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = process.env.MERCURY_PROOF_DIST ?? join(ROOT, 'dist', 'mercury.mjs')
const SCRIPT = 'tool-write'
const WITNESS = 'one-tool-write-witness.txt'
const CONTENT = 'written by the scripted write tool\n'
const CLOSING = 'VERDICT-TURN-DONE'
const PROMPT = 'write the witness file'
const COMPOSER = 'Type a prompt'
const CARD = `Do you want to create ${WITNESS}?`
const APPROVE = '1. Yes'
const HOLE = /not built(?::\s*(\S+))?/g
const COLS = 120
const ROWS = 40

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const driver = posixPtyDriverOrSkip('prove-one-prompt-one-card-drive')
if (!existsSync(DIST)) {
  console.error(`  [FAIL] ${DIST} missing — run bun run build.ts first; this drive runs the built bundle`)
  process.exit(1)
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'one-prompt-one-card-')))
const home = join(root, 'home')
const work = join(root, 'work')
const daemon = join(root, 'daemon')
for (const dir of [home, work, daemon]) mkdirSync(dir, { recursive: true })
seedFirstRun(home, [work])
const witness = join(work, WITNESS)
const node = nodeBinPath()

console.log('============================================================')
console.log(' one prompt, one tool, one permission card — the built bundle in a terminal')
console.log('============================================================')

const pty = recordPty({
  argv: [node, DIST],
  cwd: work,
  env: {
    HOME: root,
    TMPDIR: tmpdir(),
    PATH: `/usr/bin:/bin:${dirname(node)}`,
    TERM: 'xterm-256color',
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: daemon,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_SCRIPTED_STREAM: SCRIPT,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  },
  cols: COLS,
  rows: ROWS,
  path: join(root, 'pty.bin'),
})

const holes = new Set<string>()
const noteHoles = (where: string, text: string): void => {
  for (const hit of text.matchAll(HOLE)) holes.add(`${hit[1] ?? 'no id'} (${where})`)
}
const output = (): Buffer[] => pty.records.filter(row => row.direction === 'output').map(row => row.bytes)
let drawn = -1
let last = ''
function frame(): string {
  const chunks = output()
  if (chunks.length === drawn) return last
  drawn = chunks.length
  const tee = join(root, 'frame.tee')
  writeFileSync(
    tee,
    Buffer.concat(
      chunks.map((bytes, index) => {
        const head = Buffer.alloc(8)
        head.writeUInt32BE(index)
        head.writeUInt32BE(bytes.length, 4)
        return Buffer.concat([head, bytes])
      }),
    ),
  )
  const read = spawnSync(driver.python, [join(ROOT, 'scripts', 'ui', 'replay-tee-grid.py'), tee, String(COLS), String(ROWS), join(root, 'frame.json')], { encoding: 'utf8' })
  if (read.status !== 0) throw new Error(`scripts/ui/replay-tee-grid.py could not replay the terminal bytes (exit ${read.status}): ${read.stderr.trim()}`)
  last = read.stdout
  noteHoles('drawn', last)
  return last
}
const shows = (test: (text: string) => boolean, ms: number): Promise<boolean> => untilAsync(() => test(frame()), vshotBudgetMs(ms), 100)
const stripAnsi = (raw: string): string =>
  raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
const printedFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return printedFiles(path)
    return entry.isFile() && /\.(?:log|jsonl)$/.test(entry.name) ? [path] : []
  })

const runProcesses = (): number[] => {
  const table = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .stdout.split('\n')
    .flatMap(line => {
      const row = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      return row === null ? [] : [{ pid: Number(row[1]), parent: Number(row[2]), command: row[3] as string }]
    })
  const mine = new Set(table.filter(row => row.command.includes(root) || (row.parent === process.pid && row.command.includes(DIST))).map(row => row.pid))
  for (let grew = true; grew; ) {
    grew = false
    for (const row of table) {
      if (mine.has(row.pid) || !mine.has(row.parent)) continue
      mine.add(row.pid)
      grew = true
    }
  }
  return [...mine]
}
const alive = (pids: number[]): number[] =>
  pids.filter(pid => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })

let reached = 'the boot face'
let ended = false
try {
  const booted = await shows(paintsBootFaceReady, 60_000)
  if (booted) {
    reached = 'the composer'
    pty.send('\r')
  }
  const composing = booted && (await shows(text => text.includes(COMPOSER), 60_000))
  if (composing) {
    reached = 'the typed prompt in the composer'
    pty.send(PROMPT)
  }
  const typed = composing && (await shows(text => text.includes(`❯ ${PROMPT}`), 30_000))
  if (typed) {
    reached = 'the permission card'
    pty.send('\r')
  }
  const carded = typed && (await shows(text => text.includes(CARD) && text.includes(APPROVE), 60_000))
  const absent = !existsSync(witness)
  check(
    `(a) a frame shows the permission card for the file write (${CARD}) while ${WITNESS} does not exist`,
    carded && absent,
    carded ? `the card is on the screen and ${WITNESS} already exists: the write ran before it was approved` : `the card never came up; the run stopped before ${reached}`,
  )
  if (carded) pty.send('\r')
  const written = carded && (await untilAsync(() => existsSync(witness) && readFileSync(witness, 'utf8') === CONTENT, vshotBudgetMs(30_000), 100))
  check(
    `(b) after the card is approved ${WITNESS} exists with the scripted content`,
    written,
    !carded ? 'the card was never approved because it never came up' : existsSync(witness) ? `the file holds ${JSON.stringify(readFileSync(witness, 'utf8'))}, the script writes ${JSON.stringify(CONTENT)}` : `${WITNESS} was not written after Enter on the card`,
  )
  const settled = await shows(text => text.includes(CLOSING) && text.includes(COMPOSER), written ? 60_000 : 2_000)
  const closing = frame().includes(CLOSING)
  check(`(c) the last frame shows the closing line ${CLOSING}`, closing, 'the closing line of the script is not on the last frame')
  if (closing && !settled) console.log(`  [NOTE] the closing line is drawn and the composer did not come back within ${vshotBudgetMs(60_000)} ms`)
  noteHoles('printed to the terminal', stripAnsi(Buffer.concat(output()).toString('utf8')))
  for (const path of printedFiles(root)) noteHoles(relative(root, path), readFileSync(path, 'utf8'))
  check(
    '(d) nothing the run printed or drew holds `not built`',
    holes.size === 0,
    `${holes.size} hole(s) crossed, to be filled next: ${[...holes].join(', ')}`,
  )
  if (failures > 0) {
    console.log(`\n  the last frame (${COLS}x${ROWS}):`)
    console.log(last.split('\n').map(line => `  | ${line}`).join('\n'))
    const log = join(daemon, 'daemon.log')
    if (existsSync(log)) console.log(`\n  the last lines of the background service's log:\n${readFileSync(log, 'utf8').split('\n').slice(-12).map(line => `  | ${line}`).join('\n')}`)
  }
} finally {
  const mine = runProcesses()
  void pty.close().then(
    () => {
      ended = true
    },
    () => {
      ended = true
    },
  )
  await untilAsync(() => ended && alive(mine).length === 0, vshotBudgetMs(10_000), 50)
  for (const pid of alive(mine)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      void 0
    }
  }
  await untilAsync(() => alive(mine).length === 0, vshotBudgetMs(5_000), 50)
  removeScratch(root)
}

if (failures > 0) {
  console.error(`\nprove-one-prompt-one-card-drive: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-one-prompt-one-card-drive: all green')
process.exit(0)
