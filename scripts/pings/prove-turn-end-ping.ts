#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { DIST, nodeBinPath, requireDist } from '../streaming/artifactArena.ts'
import { PING_MESSAGE } from '../../src/hooks/useTurnEndPing.ts'

const VSHOT = join(import.meta.dir, '..', 'ui', 'vshot.py')
const API_KEY = 'fixture-key-000'
const PYTHON_USER_SITE = spawnSync('/usr/bin/python3', ['-c', 'import site; print(site.getusersitepackages())'], {
  encoding: 'utf8',
}).stdout.trim()
const COLS = 120
const ROWS = 40
const TICK_MS = 200
const FOCUS_OUT = '\x1b[O'
const FOCUS_IN = '\x1b[I'
const ESC = '\x1b'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

requireDist()

type Send = Record<string, unknown>
const awaits = (needle: string, data: string, extra: Send = {}): Send => ({
  requireAwait: true,
  awaitText: needle,
  awaitSettleTicks: 3,
  minTick: 5,
  data,
  ...extra,
})
const IDLE = '? for shortcuts'
const BUSY = 'esc interrupt'
const past = (needle: string, ticks: number, data: string, extra: Send = {}): Send => awaits(needle, data, { awaitSettleTicks: ticks, ...extra })
const pause = (needle: string, ticks: number, mark: string): Send => past(needle, ticks, '', { mark })
const opening = (): Send[] => [awaits('↑↓ choose', '\r', { awaitSettleTicks: 4 }), awaits('ype a prompt', '', { minTick: 8, awaitSettleTicks: 5, mark: 'composer' })]
const submit = (prompt: string, focus: string | null): Send[] => [
  past(IDLE, 1, prompt),
  past(prompt, 2, '\r'),
  ...(focus === null ? [] : [past(BUSY, 1, focus)]),
]
const turn = (prompt: string, focus: string | null, finalText: string, mark: string, settleTicks: number): Send[] => [
  ...submit(prompt, focus),
  awaits(finalText, '', { awaitSettleTicks: 1, mark: `end-${mark}`, minTick: 5 }),
  pause(finalText, settleTicks, `after-${mark}`),
]

type Frame = { tick: number; data: Buffer }
function framesOf(tee: Buffer): Frame[] {
  const out: Frame[] = []
  let off = 0
  while (off + 8 <= tee.length) {
    const tick = tee.readUInt32BE(off)
    const len = tee.readUInt32BE(off + 4)
    off += 8
    if (off + len > tee.length) break
    out.push({ tick, data: tee.subarray(off, off + len) })
    off += len
  }
  return out
}
function bytesBetween(frames: Frame[], fromTick: number, toTick: number): string {
  return Buffer.concat(frames.filter(f => f.tick >= fromTick && f.tick < toTick).map(f => f.data)).toString('latin1')
}
type Pings = { osc9: number; bell: number }
function pingsIn(text: string): Pings {
  const osc9 = (text.match(/\x1b\]9;\r?\n\r?\n/g) ?? []).length
  const stripped = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1bP[\s\S]*?\x1b\\/g, '')
  const bell = (stripped.match(/\x07/g) ?? []).length
  return { osc9, bell }
}
const words = (p: Pings): string => `osc9=${p.osc9} bell=${p.bell}`

type Payload = { grid: { c: string }[][]; marks?: Array<{ label: string; atTick: number; grid: { c: string }[][] }>; endReason?: string; sendReceipts?: Array<{ atTick: number; ts: number }> }
interface Drive {
  frames: Frame[]
  markTick: (label: string) => number
  endReason: string
  status: number | null
  final: string[]
  world: string
  requests: number
  discard: () => void
}

interface World {
  home: string
  configDir: string
  cwd: string
  world: string
}
function makeWorld(tag: string): World {
  const world = mkdtempSync(join(realpathSync(tmpdir()), `mercury-ping-${tag}-`))
  const home = join(world, 'home')
  const cwd = join(world, 'project')
  const configDir = join(home, '.mercury')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(
    join(configDir, '.config.json'),
    JSON.stringify({
      theme: 'dark',
      hasCompletedOnboarding: true,
      customApiKeyResponses: { approved: [API_KEY.slice(-20)] },
      projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      switchboardCapacity: { askedAt: 0, allowed: true, recommendedSeats: 5 },
    }),
  )
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ guardrails: { disableFlowMode: true } }))
  return { home, configDir, cwd, world }
}

function envFor(w: World, fixtureUrl: string, terminal: string | null, nodeBin: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...(process.env.MERCURY_VSHOT_BUDGET_SCALE ? { MERCURY_VSHOT_BUDGET_SCALE: process.env.MERCURY_VSHOT_BUDGET_SCALE } : {}),
    HOME: w.home,
    PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
    PYTHONPATH: PYTHON_USER_SITE,
    TERM: 'xterm-256color',
    MERCURY_CONFIG_DIR: w.configDir,
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_BASE_URL: fixtureUrl,
    ANTHROPIC_API_KEY: API_KEY,
    MERCURY_DAEMON_DIR: join(w.home, 'daemon'),
    MERCURY_CREWS_DIR: join(w.home, 'crews'),
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_UPDATE_NOTICE: '0',
  }
  if (terminal !== null) env.TERM_PROGRAM = terminal
  return env
}

async function drive(
  tag: string,
  turns: ScriptedTurn[],
  sends: Send[],
  readyText: string,
  terminal: string | null,
  total: number,
  onTee?: (frames: Frame[], w: World) => void,
): Promise<Drive> {
  const fixture = await startFixtureApi([...turns, { kind: 'text', text: 'Spare.' }, { kind: 'text', text: 'Spare.' }, { kind: 'text', text: 'Spare.' }])
  const nodeBin = nodeBinPath()
  const w = makeWorld(tag)
  const out = join(w.world, `grid-${tag}.json`)
  const teePath = join(w.world, `tee-${tag}.bin`)
  const cfgPath = join(w.world, `cfg-${tag}.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: [nodeBin, DIST], cwd: w.cwd, sends, readyText: [readyText], stableTicks: 4, total, cols: COLS, rows: ROWS, out }))
  const env = { ...envFor(w, fixture.url, terminal, nodeBin), VSHOT_TEE: teePath }
  const child = spawn('/usr/bin/python3', [VSHOT, cfgPath], { cwd: w.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let driverOut = ''
  child.stdout.on('data', d => (driverOut += d))
  child.stderr.on('data', d => (driverOut += d))
  const killer = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(total * TICK_MS + 30_000))
  let watcher: ReturnType<typeof setInterval> | null = null
  if (onTee) {
    watcher = setInterval(() => {
      if (!existsSync(teePath)) return
      onTee(framesOf(readFileSync(teePath)), w)
    }, 250)
  }
  const status = await new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  clearTimeout(killer)
  if (watcher !== null) clearInterval(watcher)
  await fixture.close()
  let payload: Payload = { grid: [] }
  if (existsSync(out)) payload = JSON.parse(readFileSync(out, 'utf8')) as Payload
  const frames = existsSync(teePath) ? framesOf(readFileSync(teePath)) : []
  if (status !== 0) {
    console.log(`  [driver] ${tag}: vshot exit ${status}; end=${payload.endReason}; tail: ${driverOut.split('\n').filter(Boolean).slice(-4).join(' | ')}`)
    for (const r of fixture.requests) {
      const body = r.body as { model?: string; messages?: Array<{ role?: string; content?: unknown }> } | null
      const last = body?.messages?.at(-1)
      const kinds = Array.isArray(last?.content) ? (last!.content as Array<{ type?: string }>).map(b => b.type).join('+') : typeof last?.content
      console.log(`  [wire] ${r.method} ${r.path} model=${body?.model ?? '-'} last=${last?.role ?? '-'}:${kinds ?? '-'}`)
    }
  }
  const marks = new Map<string, number>()
  for (const m of payload.marks ?? []) marks.set(m.label, m.atTick)
  return {
    frames,
    markTick: label => {
      const t = marks.get(label)
      if (t === undefined) {
        check(`mark ${label} was recorded`, false, `marks: ${[...marks.keys()].join(',') || 'none'} · end=${payload.endReason}`)
        return -1
      }
      return t
    },
    endReason: payload.endReason ?? '',
    status,
    final: payload.grid.map(r => r.map(c => c.c || ' ').join('')),
    world: w.world,
    requests: fixture.requests.filter(r => r.path.includes('/v1/messages')).length,
    discard: () => rmSync(w.world, { recursive: true, force: true }),
  }
}

const LEAD = 5
function window(d: Drive, fromMark: string, toMark: string, lead = LEAD): Pings {
  const from = d.markTick(fromMark)
  const to = d.markTick(toMark)
  if (from < 0 || to < 0) return { osc9: -1, bell: -1 }
  return pingsIn(bytesBetween(d.frames, Math.max(0, from - lead), to + 1))
}
function quietBetween(d: Drive, afterMark: string, nextEndMark: string): Pings {
  const from = d.markTick(afterMark)
  const to = d.markTick(nextEndMark)
  if (from < 0 || to < 0) return { osc9: -1, bell: -1 }
  return pingsIn(bytesBetween(d.frames, from + 1, Math.max(from + 1, to - LEAD)))
}

const only = process.argv[2]?.toUpperCase()
const wants = (leg: string): boolean => only === undefined || only === leg

const P1 = 'first turn: say the word apricot'
const P2 = 'second turn: say the word banana'
const P3 = 'third turn: say the word cherry'
const F1 = 'Apricot, as asked.'
const F2 = 'Banana, as asked.'
const F3 = 'Cherry, as asked.'
const HOLD_MS = 2500
const slow = (text: string, said: string): ScriptedTurn => ({ kind: 'paced', deltas: [text], gapMs: 10, startDelayMs: HOLD_MS, whenSaid: said })
const textTurns: ScriptedTurn[] = [slow(F1, P1), slow(F2, P2), slow(F3, P3)]

if (wants('A')) {
  section('LEG A — iTerm2, blurred: one OSC 9 ping per finished turn, never twice, and view.ping: false silences the next turn without a restart')
  let switchedOff = false
  const d = await drive(
    'a',
    textTurns,
    [
      ...opening(),
      ...turn(P1, FOCUS_OUT, F1, '1', 15),
      ...turn(P2, FOCUS_OUT, F2, '2', 15),
      pause(F2, 40, 'settings-written'),
      ...turn(P3, FOCUS_OUT, F3, '3', 25),
    ],
    F3,
    'iTerm.app',
    900,
    (frames, w) => {
      if (switchedOff) return
      const all = pingsIn(bytesBetween(frames, 0, 1 << 30))
      if (all.osc9 >= 2) {
        writeFileSync(join(w.configDir, 'settings.json'), JSON.stringify({ guardrails: { disableFlowMode: true }, view: { ping: false } }))
        switchedOff = true
      }
    },
  )
  check('A: the drive completed (three turns answered on screen)', d.status === 0 && d.final.some(r => r.includes(F3)), `status=${d.status} end=${d.endReason}`)
  const t1 = window(d, 'end-1', 'after-1')
  check('A: the first turn end, blurred, pings ONCE with OSC 9 and no bare bell', t1.osc9 === 1 && t1.bell === 0, words(t1))
  const quiet = quietBetween(d, 'after-1', 'end-2')
  check('A: nothing pings between the first turn end and the second (not twice for one turn)', quiet.osc9 === 0 && quiet.bell === 0, words(quiet))
  const t2 = window(d, 'end-2', 'after-2')
  check('A: the second turn end pings once more (one per finished turn)', t2.osc9 === 1 && t2.bell === 0, words(t2))
  check('A: the proof wrote view.ping: false after the second ping (the switch flipped mid-session)', switchedOff)
  const t3 = window(d, 'end-3', 'after-3')
  check('A: with view.ping false the third turn end pings NOTHING — read at fire time, no restart', t3.osc9 === 0 && t3.bell === 0, words(t3))
  const before = pingsIn(bytesBetween(d.frames, 0, d.markTick('end-1') - 5))
  check('A: nothing pinged before the first turn ended (no boot ping, no submit ping)', before.osc9 === 0 && before.bell === 0, words(before))
  const payloadText = bytesBetween(d.frames, 0, 1 << 30)
  check('A: the OSC 9 payload carries the ping words', new RegExp(`\\]9;\\r?\\n\\r?\\n${PING_MESSAGE}\\x07`).test(payloadText))
  if (failures === 0) d.discard()
  else console.log(`  [forensics] world kept: ${d.world}`)
}

if (wants('B')) {
  const before = failures
  section('LEG B — another terminal, blurred: the bell, once, and no OSC 9')
  const d = await drive('b', textTurns, [...opening(), ...turn(P1, FOCUS_OUT, F1, '1', 15)], F1, 'Apple_Terminal', 400)
  check('B: the drive completed', d.status === 0 && d.final.some(r => r.includes(F1)), `status=${d.status} end=${d.endReason}`)
  const t1 = window(d, 'end-1', 'after-1')
  check('B: the turn end rings the bell exactly once, through the same emitter, with no OSC 9', t1.bell === 1 && t1.osc9 === 0, words(t1))
  const pre = pingsIn(bytesBetween(d.frames, 0, d.markTick('end-1') - 5))
  check('B: no bell before the turn ended', pre.bell === 0 && pre.osc9 === 0, words(pre))
  if (failures === before) d.discard()
  else console.log(`  [forensics] world kept: ${d.world}`)
}

if (wants('C')) {
  const before = failures
  section('LEG C — iTerm2, focused: a turn that ends under your eyes never pings')
  const d = await drive('c', textTurns, [...opening(), ...turn(P1, FOCUS_IN, F1, '1', 45)], F1, 'iTerm.app', 400)
  check('C: the drive completed', d.status === 0 && d.final.some(r => r.includes(F1)), `status=${d.status} end=${d.endReason}`)
  const t1 = window(d, 'end-1', 'after-1')
  check('C: nine seconds after the turn end, focused: no ping of either kind', t1.osc9 === 0 && t1.bell === 0, words(t1))
  if (failures === before) d.discard()
  else console.log(`  [forensics] world kept: ${d.world}`)
}

if (wants('D')) {
  const before = failures
  section('LEG D — focus unreported: the ping waits one window and fires once; a key inside the window holds it')
  const d = await drive(
    'd',
    textTurns,
    [
      ...opening(),
      ...turn(P1, null, F1, '1', 20),
      pause(F1, 30, 'later-1'),
      ...submit(P2, null),
      awaits(F2, '', { awaitSettleTicks: 1, mark: 'end-2', minTick: 5 }),
      past(F2, 8, 'x'),
      pause(F2, 55, 'after-2'),
    ],
    F2,
    'iTerm.app',
    800,
  )
  check('D: the drive completed', d.status === 0 && d.final.some(r => r.includes(F2)), `status=${d.status} end=${d.endReason}`)
  const early = window(d, 'end-1', 'after-1')
  check('D: four seconds after the turn end nothing has pinged yet (the window is still open)', early.osc9 === 0 && early.bell === 0, words(early))
  const later = window(d, 'after-1', 'later-1', 1)
  check('D: between four and ten seconds the ping fires exactly once (no input in the window)', later.osc9 === 1 && later.bell === 0, words(later))
  const held = window(d, 'end-2', 'after-2')
  check('D: a key pressed inside the window after the second turn end holds the ping — nothing fires in eleven seconds', held.osc9 === 0 && held.bell === 0, words(held))
  if (failures === before) d.discard()
  else console.log(`  [forensics] world kept: ${d.world}`)
}

if (wants('E')) {
  const before = failures
  section('LEG E — iTerm2, blurred: a consent card and a question card never ping; the finished turn after each does, once')
  const PC = 'consent turn: write the marker file'
  const PQ = 'question turn: ask me the colour'
  const FC = 'The marker was written, as asked.'
  const FQ = 'Colour noted, as asked.'
  const CARD_1 = 'ping-consent-marker'
  const CARD_2 = 'colour should the badge'
  const cardTurns: ScriptedTurn[] = [
    { kind: 'tool_use', name: 'Write', id: 'write_ping_consent', input: { file_path: 'ping-consent-marker.txt', content: 'ping\n' }, whenSaid: PC },
    { kind: 'paced', deltas: [FC], gapMs: 10, startDelayMs: HOLD_MS, whenBody: 'write_ping_consent' },
    {
      kind: 'tool_use',
      name: 'AskUserQuestion',
      id: 'auq_ping_question',
      input: { questions: [{ question: 'Which colour should the badge wear?', header: 'Colour', options: [{ label: 'Amber', description: 'Warm.' }, { label: 'Teal', description: 'Cool.' }] }] },
      whenSaid: PQ,
    },
    { kind: 'paced', deltas: [FQ], gapMs: 10, startDelayMs: HOLD_MS, whenBody: 'auq_ping_question' },
  ]
  const d = await drive(
    'e',
    cardTurns,
    [
      ...opening(),
      ...submit(PC, FOCUS_OUT),
      awaits(CARD_1, '', { awaitSettleTicks: 2, mark: 'card-1', minTick: 5 }),
      pause(CARD_1, 35, 'card-1-held'),
      past(CARD_1, 2, '\r'),
      past(BUSY, 1, FOCUS_OUT),
      awaits(FC, '', { awaitSettleTicks: 1, mark: 'end-1', minTick: 5 }),
      pause(FC, 15, 'after-1'),
      ...submit(PQ, FOCUS_OUT),
      awaits(CARD_2, '', { awaitSettleTicks: 2, mark: 'card-2', minTick: 5 }),
      pause(CARD_2, 35, 'card-2-held'),
      past(CARD_2, 2, ESC),
      past(BUSY, 1, FOCUS_OUT),
      awaits(FQ, '', { awaitSettleTicks: 1, mark: 'end-2', minTick: 5 }),
      pause(FQ, 15, 'after-2'),
    ],
    FQ,
    'iTerm.app',
    900,
  )
  check('E: the drive completed (both cards answered, both turns finished)', d.status === 0 && d.final.some(r => r.includes(FQ)), `status=${d.status} end=${d.endReason}`)
  const consent = window(d, 'card-1', 'card-1-held', 2)
  check('E: a consent card waiting seven seconds while blurred pings nothing', consent.osc9 === 0 && consent.bell === 0, words(consent))
  const t1 = window(d, 'end-1', 'after-1')
  check('E: the turn that finished after the consent pings once', t1.osc9 === 1 && t1.bell === 0, words(t1))
  const question = window(d, 'card-2', 'card-2-held', 2)
  check('E: a question card waiting seven seconds while blurred pings nothing', question.osc9 === 0 && question.bell === 0, words(question))
  const t2 = window(d, 'end-2', 'after-2')
  check('E: the turn that finished after the question pings once', t2.osc9 === 1 && t2.bell === 0, words(t2))
  if (failures === before) d.discard()
  else console.log(`  [forensics] world kept: ${d.world}`)
}

if (wants('F')) {
  const before = failures
  section('LEG F — a headless run on an iTerm2 terminal emits no ping bytes at all')
  const fixture = await startFixtureApi([{ kind: 'text', text: 'Headless, as asked.' }, { kind: 'text', text: 'Spare.' }, { kind: 'text', text: 'Spare.' }], { jsonForNonStream: true })
  const nodeBin = nodeBinPath()
  const w = makeWorld('f')
  const env = envFor(w, fixture.url, 'iTerm.app', nodeBin)
  const child = spawn(nodeBin, [DIST, 'run', 'headless turn: say the word date'], { cwd: w.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.end()
  const chunks: Buffer[] = []
  child.stdout.on('data', c => chunks.push(c as Buffer))
  child.stderr.on('data', c => chunks.push(c as Buffer))
  const killer = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(120_000))
  const status = await new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  clearTimeout(killer)
  await fixture.close()
  const out = Buffer.concat(chunks).toString('latin1')
  check('F: the run answered', status === 0 && out.includes('Headless, as asked.'), `status=${status} tail=${out.slice(-200)}`)
  const p = pingsIn(out)
  check('F: no OSC 9 and no bell byte anywhere in the run output', p.osc9 === 0 && p.bell === 0, words(p))
  if (failures === before) rmSync(w.world, { recursive: true, force: true })
  else console.log(`  [forensics] world kept: ${w.world}`)
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
