#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME, SID, cleanupScenario, scenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const PARK_REASON = 'parked — the daemon was stopped'

console.log('============================================================')
console.log(" /sessions — the 'this session' row says parked when the daemon stop parked it")
console.log('============================================================')

console.log('\n(A) the words, from the record')
const view = (await import('../../src/components/mercury-ui/screens/SessionManagerView.tsx')) as { ownSessionStateWords?: (rec: { parkedAt?: number; parkReason?: string; endedAt?: number } | undefined) => { glyph: string; state: string; tail: string; parked: boolean } }
if (view.ownSessionStateWords === undefined) {
  check('the view reads its own session\'s record (ownSessionStateWords)', false, 'not exported')
} else {
  const ownSessionStateWords = view.ownSessionStateWords
  const parked = ownSessionStateWords({ parkedAt: 1, parkReason: PARK_REASON })
  check("a parked record reads the park's own reason, the board's vocabulary, with the way back", parked.parked && parked.glyph === '◌' && parked.state === PARK_REASON && parked.tail.includes('the next prompt resumes it'), JSON.stringify(parked))
  const bare = ownSessionStateWords({ parkedAt: 1 })
  check('a parked record without a reason reads parked', bare.parked && bare.state === 'parked', JSON.stringify(bare))
  const live = ownSessionStateWords({})
  check('a live record reads active with the browsing words', !live.parked && live.glyph === '●' && live.state === 'active' && live.tail === ' · browsing never closes it · switching pauses the current, state kept', JSON.stringify(live))
  const ended = ownSessionStateWords({ parkedAt: 1, parkReason: PARK_REASON, endedAt: 2 })
  check('an ended record is not this session\'s park', !ended.parked, JSON.stringify(ended))
  check('no record reads active', !ownSessionStateWords(undefined).parked)
}

console.log('\n(B) the screen: a chat whose daemon was stopped under it opens /sessions')
type Cell = { c: string }
const DAEMON_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'sessions-own-row-daemon-')))
const cfg = scenario('sessions-manager', 120, 40) as Record<string, unknown> & { argv: string[] }
const gridPath = `/tmp/sessions-own-row-${process.pid}.json`
const cfgPath = `/tmp/sessions-own-row-cfg-${process.pid}.json`
writeFileSync(cfgPath, JSON.stringify({
  ...cfg,
  sends: [
    { data: '/sessions', atTick: 999, awaitText: 'Type a prompt', requireAwait: true, minTick: 110, awaitSettleTicks: 2 },
    { data: '\r', atTick: 999, awaitText: '❯ /sessions', requireAwait: true, minTick: 1, awaitSettleTicks: 1 },
  ],
  readyText: 'Switch to',
  stableTicks: 4,
  total: 200,
  out: gridPath,
}))
const env = { ...process.env, MERCURY_CONFIG_DIR: CONFIG_HOME, MERCURY_DAEMON_DIR: DAEMON_DIR }
const workersPath = join(DAEMON_DIR, 'concourse-workers.json')
const recordOf = (): { sessionId?: string; pid?: number; parkedAt?: number; parkReason?: string; endedAt?: number } | undefined => {
  try {
    const raw = JSON.parse(readFileSync(workersPath, 'utf8')) as { workers?: Record<string, { sessionId?: string; pid?: number; parkedAt?: number; parkReason?: string; endedAt?: number }> }
    return Object.values(raw.workers ?? {}).find(rec => rec.sessionId === SID && rec.endedAt === undefined)
  } catch {
    return undefined
  }
}
const capture = spawn('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfgPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let captureErr = ''
capture.stderr.on('data', chunk => { captureErr += String(chunk) })
const started = Date.now()
const admittedRecord = (): boolean => typeof recordOf()?.pid === 'number'
const admitted = admittedRecord() || await new Promise<boolean>(settle => {
  const watcher = watch(DAEMON_DIR, () => {
    if (!admittedRecord()) return
    clearTimeout(ceiling)
    watcher.close()
    settle(true)
  })
  const ceiling = setTimeout(() => {
    watcher.close()
    settle(admittedRecord())
  }, 20_000)
})
check('the resumed chat is admitted on its own daemon (a worker record with a pid for the session)', admitted, `${Math.round((Date.now() - started) / 1000)}s · ${existsSync(workersPath) ? readFileSync(workersPath, 'utf8').slice(0, 300) : 'no workers file'}`)
let stopLine = ''
if (admitted) {
  const stop = spawnSync('node', [cfg.argv[1]!, 'daemon', 'stop'], { env, encoding: 'utf8', timeout: 30_000 })
  stopLine = `${stop.stdout ?? ''}${stop.stderr ?? ''}`.trim()
  const afterStop = recordOf()
  check('mercury daemon stop parks the session (the record carries the stop\'s reason)', /shutdown acknowledged/.test(stopLine) && afterStop?.parkedAt !== undefined && afterStop.parkReason === PARK_REASON, `${stopLine.slice(0, 200)} · ${JSON.stringify(afterStop)}`)
}
const exit: number | null = await new Promise(resolve => capture.on('close', code => resolve(code)))
rmSync(cfgPath, { force: true })
const atEnd = (() => { try { return readFileSync(workersPath, 'utf8') } catch { return 'no workers file' } })()
console.log(`  · the records at the capture's end: ${atEnd.replace(/\s+/g, ' ').slice(0, 700)}`)
if (exit !== 0 || !existsSync(gridPath)) {
  check('PTY capture ran', false, captureErr.slice(-400))
} else {
  const grid = (JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: Cell[][] }).grid
  rmSync(gridPath, { force: true })
  const rows = grid.map(row => row.map(cell => cell.c).join('').trimEnd())
  const own = rows.find(row => row.includes('this session')) ?? ''
  check("the 'this session' row reads parked with the park's reason, never active, with the daemon stopped under it", own.includes(`◌ ${PARK_REASON}`) && !own.includes('● active'), own || rows.filter(r => r.trim() !== '').slice(-10).join(' | '))
  check('…and says the next prompt resumes it', own.includes('the next prompt resumes it'), own)
}
cleanupScenario('sessions-manager')
rmSync(DAEMON_DIR, { recursive: true, force: true })

console.log(`\n${failures === 0 ? '✅ the own-session row tells the park — PROVEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
