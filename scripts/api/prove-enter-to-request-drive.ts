#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { paintsBootFaceReady } from '../lib/bootFace.ts'
import { posixPtyDriverOrSkip, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { nodeBinPath } from '../lib/nodeBin.ts'
import { recordPty, sharedClockMs } from '../lib/ptyRecorder.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { untilAsync } from '../lib/untilAsync.ts'
import { repeatOf, roads, serveRoad, writeProject, type Road, type Step } from './turnCostFixture.ts'

type Ask = { label: string; words: string; steps: Step[]; closing: string }

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = process.env.MERCURY_PROOF_DIST ?? join(ROOT, 'dist', 'mercury.mjs')
const COLS = 120
const ROWS = 40
const COMPOSER = 'Type a prompt'
const RESTING = ' ready · '
const flagValue = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const outDir = flagValue('--out')
const onlyRoad = flagValue('--road')
const settleMs = Number(flagValue('--settle') ?? '0')

let failures = 0
const check = (label: string, ok: boolean, detail: string): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail}`}`)
}

const driver = posixPtyDriverOrSkip('prove-enter-to-request-drive')
if (!existsSync(DIST)) {
  console.error(`  [FAIL] ${DIST} missing — run bun run build.ts first; this drive runs the built bundle`)
  process.exit(1)
}
if (outDir !== undefined) mkdirSync(outDir, { recursive: true })

function asks(work: string): Ask[] {
  return [
    {
      label: 'first',
      words: 'read the sum file',
      steps: [{ name: 'Read', input: { file_path: join(work, 'src', 'sum.js') } }, { name: 'Read', input: { file_path: join(work, 'test', 'sum.test.js') } }, { say: 'ENTER-ONE-DONE' }],
      closing: 'ENTER-ONE-DONE',
    },
    {
      label: 'second',
      words: 'read the package file',
      steps: [{ name: 'Read', input: { file_path: join(work, 'package.json') } }, { say: 'ENTER-TWO-DONE' }],
      closing: 'ENTER-TWO-DONE',
    },
    {
      label: 'third',
      words: 'say it once more',
      steps: [{ say: 'ENTER-THREE-DONE' }],
      closing: 'ENTER-THREE-DONE',
    },
  ]
}

async function driveRoad(road: Road, table: string[]): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'enter-to-request-')))
  const home = join(root, 'home')
  const work = join(root, 'work')
  const daemon = join(root, 'daemon')
  for (const dir of [home, work, daemon]) mkdirSync(dir, { recursive: true })
  writeProject(work, 0)
  seedFirstRun(home, [work])
  const script = asks(work)
  let current: Ask | undefined
  let answered = 0
  const api = await serveRoad(road, () => (current === undefined ? undefined : { prompt: current.label, step: current.steps[answered++] ?? { say: 'Nothing is left to do.' } }), sharedClockMs)
  const node = nodeBinPath()
  const pty = recordPty({
    argv: [node, DIST, '--model', road.model, ...(outDir === undefined ? [] : ['--log-file', join(outDir, `${road.name}-tui-debug.log`)])],
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
      ...road.env(api.base),
    },
    cols: COLS,
    rows: ROWS,
    path: join(root, 'pty.bin'),
  })
  let drawn = -1
  let last = ''
  const frame = (): string => {
    const chunks = pty.records.filter(row => row.direction === 'output').map(row => row.bytes)
    if (chunks.length === drawn) return last
    drawn = chunks.length
    const tee = join(root, 'frame.tee')
    writeFileSync(tee, Buffer.concat(chunks.map((bytes, index) => {
      const head = Buffer.alloc(8)
      head.writeUInt32BE(index)
      head.writeUInt32BE(bytes.length, 4)
      return Buffer.concat([head, bytes])
    })))
    const read = spawnSync(driver.python, [join(ROOT, 'scripts', 'ui', 'replay-tee-grid.py'), tee, String(COLS), String(ROWS), join(root, 'frame.json')], { encoding: 'utf8' })
    if (read.status !== 0) throw new Error(`scripts/ui/replay-tee-grid.py could not replay the terminal bytes (exit ${read.status}): ${read.stderr.trim()}`)
    last = read.stdout
    return last
  }
  const shows = (test: (text: string) => boolean, ms: number): Promise<boolean> => untilAsync(() => test(frame()), vshotBudgetMs(ms), 100)
  let ended = false
  try {
    const booted = await shows(paintsBootFaceReady, 60_000)
    if (booted) pty.send('\r')
    let ready = booted && (await shows(text => text.includes(COMPOSER), 60_000))
    check(`${road.name}: the composer came up`, ready, last.split('\n').filter(line => line.trim() !== '').slice(-30).join('\n'))
    if (ready && settleMs > 0) await untilAsync(() => false, settleMs, settleMs)
    for (const ask of script) {
      if (!ready) break
      pty.send(ask.words)
      const typed = await shows(text => text.includes(`❯ ${ask.words}`), 30_000)
      const before = api.seen.length
      current = ask
      answered = 0
      const enterMs = pty.send('\r')
      ready = typed && (await untilAsync(() => api.seen.length >= before + ask.steps.length, vshotBudgetMs(60_000), 20)) && (await shows(text => text.includes(ask.closing) && text.includes(RESTING), 60_000))
      check(`${road.name}: the ${ask.label} prompt was answered through its ${ask.steps.length} requests`, ready, `${api.seen.length - before} requests; ${last.split('\n').slice(-10).join('\n')}`)
      api.seen.slice(before).forEach((row, index) => {
        const earlier = api.seen[row.n - 2]
        const repeat = repeatOf(road, earlier, row)
        const enterToRequest = index === 0 ? Math.round(row.arrivedMs - enterMs) : ''
        const sinceAnswer = index === 0 || earlier === undefined ? '' : Math.round(row.arrivedMs - earlier.answeredMs)
        table.push([road.name, ask.label, row.n, enterToRequest, sinceAnswer, row.wireBytes, repeat.headBytes, repeat.cacheBytes, repeat.sharedBytes, repeat.lostBytes, repeat.brokeAt, repeat.moved].join('\t'))
        check(`${road.name}: request ${row.n} rewrote nothing the one before it sent`, repeat.lostBytes === 0, `lost ${repeat.lostBytes} bytes at ${repeat.brokeAt}`)
      })
      current = undefined
    }
    if (outDir !== undefined) api.seen.forEach(row => writeFileSync(join(outDir, `${road.name}-tui-request-${String(row.n).padStart(2, '0')}.json`), JSON.stringify(row.body, null, 1)))
    if (outDir !== undefined) writeFileSync(join(outDir, `${road.name}-tui-last-frame.txt`), last)
  } finally {
    void pty.close().then(() => { ended = true }, () => { ended = true })
    await untilAsync(() => ended, vshotBudgetMs(10_000), 50)
    await api.close()
    removeScratch(root)
  }
}

const table: string[] = [['road', 'prompt', 'request', 'ms_enter_to_request', 'ms_last_answer_to_request', 'wire_bytes', 'bytes_before_conversation', 'cache_order_bytes', 'bytes_shared_with_last', 'bytes_of_last_lost', 'broke_at', 'fields_that_moved'].join('\t')]
for (const road of roads.filter(candidate => onlyRoad === undefined || candidate.name === onlyRoad)) await driveRoad(road, table)
console.log(`\n${table.join('\n')}`)
if (outDir !== undefined) writeFileSync(join(outDir, 'ENTER.tsv'), `${table.join('\n')}\n`)
console.log(failures === 0 ? '\nprove-enter-to-request-drive: all green' : `\nprove-enter-to-request-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
