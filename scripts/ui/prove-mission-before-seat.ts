#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findRows, firstOutputTs, runArtifactArena, type ArenaRun } from '../streaming/artifactArena.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { MISSION_MET_SENTINEL } from '../../src/utils/hooks/missionHook.ts'

const argument = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const DIST = argument('--dist')
const FRAMES = argument('--frames')
const MISSION = 'relay probe'
const HOOK_WORDS = `The standing mission for this session is not yet met: ${MISSION}`
const CARD_LOOK_AFTER_MS = 2400

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

type Card = { sessionId: string; goal: string; state: string; iterations: number; nextStep: string | null }
type Screen = { atMs: number; rows: string[] }

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

function missionCards(configDir: string): Card[] {
  return walk(join(configDir, 'projects'))
    .filter(p => p.includes(`${join('missions', '')}`) && p.endsWith('.json'))
    .map(p => JSON.parse(readFileSync(p, 'utf8')) as Card)
}

function transcriptExists(configDir: string, sessionId: string): boolean {
  return walk(join(configDir, 'projects')).some(p => p.endsWith(`${sessionId}.jsonl`))
}

function lastUserText(body: unknown): string {
  const messages = (body as { messages?: Array<{ role: string; content: unknown }> }).messages ?? []
  const user = [...messages].reverse().find(m => m.role === 'user')
  return user === undefined ? '' : JSON.stringify(user.content)
}

const missionSentAt = (run: ArenaRun): number | undefined => {
  const send = run.sendLog.find(s => Buffer.from(s.b64, 'base64').toString('utf8').startsWith('/mission'))
  return send === undefined ? undefined : send.sent - firstOutputTs(run)
}

function screensAt(run: ArenaRun, cols: number, rows: number, offsets: number[]): Screen[] {
  const asked = offsets.map(o => (o < 0 ? -1 : Math.max(0, Math.round(o))))
  const res = spawnSync(
    '/usr/bin/python3',
    [join(import.meta.dir, '..', 'streaming', 'screengrab.py'), run.paths.drive, String(cols), String(rows), ...asked.map(String)],
    { encoding: 'utf8', timeout: vshotBudgetMs(60_000), maxBuffer: 64 * 1024 * 1024 },
  )
  if (res.status !== 0) throw new Error(`screengrab failed: ${res.stderr}`)
  const screens = (JSON.parse(res.stdout) as { screens: Screen[] }).screens
  return asked.map(o => {
    const found = screens.find(sc => sc.atMs === o)
    if (found === undefined) throw new Error(`no screen at ${o}`)
    return found
  })
}

async function drive(cols: number, rows: number): Promise<ArenaRun> {
  return runArtifactArena({
    turns: [
      { kind: 'text', text: 'the first answer, the mission not yet met' },
      { kind: 'text', text: `the mission is met now\n${MISSION_MET_SENTINEL}` },
    ],
    sends: [`after:no prompts sent yet:0:/mission ${MISSION}\\r`, `after:relay probe:${CARD_LOOK_AFTER_MS + 400}:hello\\r`],
    seconds: 24,
    cols,
    rows,
    keep: true,
    ...(DIST !== undefined ? { distPath: resolve(DIST) } : {}),
  })
}

console.log('============================================================')
console.log(' a /mission typed before the seat lands follows the seat')
console.log('============================================================')
console.log(`build under proof: ${DIST !== undefined ? resolve(DIST) : 'this tree'}`)

const run = await drive(120, 40)
const configDir = join(run.paths.home, '.claude')
const sentAt = missionSentAt(run)
check('the capture ran to its end and both sends fired', run.outcome.exitCode !== null && run.sendLog.length >= 2 && sentAt !== undefined, `exit=${run.outcome.exitCode} sends=${run.sendLog.length} ${run.outcome.reason ?? ''} ${run.driverOut.slice(-200)}`)
if (sentAt === undefined) {
  console.log(`\nmission before the seat: RED (${failures}/${checks}) — the command never fired`)
  process.exit(1)
}
const [atMission, atCard, atEnd] = screensAt(run, 120, 40, [sentAt - 40, sentAt + CARD_LOOK_AFTER_MS, -1])
const readyRow = (rows: string[]): number[] => findRows(rows, ' · ready')
const cards = missionCards(configDir)
const armedOrMet = cards.filter(c => c.state === 'armed' || c.state === 'met')
const continued = cards.filter(c => c.state === 'continued')
const hosted = armedOrMet.find(c => transcriptExists(configDir, c.sessionId))
const ownId = cards.find(c => !transcriptExists(configDir, c.sessionId))
const windowOpened = ownId !== undefined
console.log(`  at the send: ${readyRow(atMission!.rows).length === 0 ? 'no seat status row yet' : 'the seat status row already stood'} · the command ran ${windowOpened ? 'BEFORE the seat was admitted (the window this drive is about opened)' : 'after the seat was admitted (the window did not open on this box; the fix has nothing to do on this run)'} · cards: ${JSON.stringify(cards.map(c => ({ id: c.sessionId.slice(0, 8), state: c.state, transcript: transcriptExists(configDir, c.sessionId) })))}`)
check('the command was taken (its receipt painted) and the seat landed after it', findRows(atCard!.rows, `Mission set: ${MISSION}`).length > 0 && readyRow(atCard!.rows).length > 0, atCard!.rows.filter(r => r.includes('Mission') || r.includes('ready')).join(' | '))
check("the mission's card is keyed by the hosted chat (the id its transcript carries), not by the cockpit's own id", hosted !== undefined, JSON.stringify(cards.map(c => ({ id: c.sessionId.slice(0, 8), state: c.state, transcript: transcriptExists(configDir, c.sessionId) }))))
check("no card under the cockpit's own id stays armed: when the command ran before admission, that card reads continued and names the hosted chat", !windowOpened || (ownId?.state === 'continued' && hosted !== undefined && (ownId.nextStep ?? '').includes(hosted.sessionId)), JSON.stringify({ own: ownId, continued }))
check("the rail's MISSION card paints the mission once the seat has landed", findRows(atCard!.rows, `◆ ${MISSION}`).length > 0, atCard!.rows.slice(0, 20).map(r => r.slice(0, 32)).join(' | '))
const requests = run.fixture.messageRequests()
const hookRequest = requests.find(r => lastUserText(r.body).includes(HOOK_WORDS))
check("the hosted runner's Stop hook saw the mission: it refused the first stop and re-prompted with the goal (a second request carries the hook's words)", hookRequest !== undefined, `requests=${requests.length}`)
check('the mission met on the sentinel: the hosted card reads met after one check', hosted?.state === 'met' && hosted.iterations === 1, JSON.stringify(hosted))
check('the reply that met the mission painted', findRows(atEnd!.rows, 'the mission is met now').length > 0, atEnd!.rows.slice(-12).join(' | '))

if (FRAMES !== undefined) {
  const dir = resolve(FRAMES)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'rail-120x40-at-send.txt'), `${atMission!.rows.join('\n')}\n`)
  writeFileSync(join(dir, 'rail-120x40-after-landing.txt'), `${atCard!.rows.join('\n')}\n`)
  writeFileSync(join(dir, 'rail-120x40-end.txt'), `${atEnd!.rows.join('\n')}\n`)
  writeFileSync(join(dir, 'cards.json'), `${JSON.stringify(cards, null, 1)}\n`)
  writeFileSync(join(dir, 'requests.json'), `${JSON.stringify(requests.map(r => lastUserText(r.body)), null, 1)}\n`)
  for (const [cols, rows] of [[80, 21], [80, 14], [82, 17]] as const) {
    const compact = await drive(cols, rows)
    const compactSent = missionSentAt(compact) ?? 0
    const [send, after] = screensAt(compact, cols, rows, [compactSent - 40, compactSent + CARD_LOOK_AFTER_MS])
    writeFileSync(join(dir, `compact-${cols}x${rows}-at-send.txt`), `${send!.rows.join('\n')}\n`)
    writeFileSync(join(dir, `compact-${cols}x${rows}-after-landing.txt`), `${after!.rows.join('\n')}\n`)
    compact.cleanup()
  }
}
run.cleanup()
console.log(`\nmission before the seat: ${failures === 0 ? `green (${checks} checks)` : `RED (${failures}/${checks})`}`)
process.exit(failures === 0 ? 0 : 1)
