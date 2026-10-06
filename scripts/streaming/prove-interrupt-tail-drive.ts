#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { type AvailableCaptureDriver, captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = path.resolve(import.meta.dir, '../..')
const DIST = path.join(REPO, 'dist/mercury.mjs')
const FIXTURE = path.join(import.meta.dir, 'turn-end-fixture-server.ts')
const BUN = process.env.BUN ?? path.join(process.env.HOME ?? '', '.bun/bin/bun')

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

async function connectorScenes(): Promise<void> {
  const saved = { config: process.env.MERCURY_CONFIG_DIR, daemon: process.env.MERCURY_DAEMON_DIR, home: process.env.MERCURY_HOME }
  const configDir = mkdtempSync(path.join(tmpdir(), 'interrupt-tail-home-'))
  const daemonDir = mkdtempSync(path.join(tmpdir(), 'interrupt-tail-daemon-'))
  process.env.MERCURY_CONFIG_DIR = configDir
  process.env.MERCURY_DAEMON_DIR = daemonDir
  delete process.env.MERCURY_HOME

  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
  const { publishSessionTail } = await import('../../src/services/engine-connector/seatProjections.ts')
  const { createAssistantMessage, createUserMessage, createUserInterruptionMessage } = await import('../../src/utils/messages/factories.ts')
  const { recordTranscript, flushSessionStorage } = await import('../../src/utils/sessionStorage.ts')
  const { getTranscriptPath } = await import('../../src/utils/sessionStorage/paths.ts')

  type Guts = {
    attached: boolean
    tick: () => Promise<void>
    readTail: () => void
    recomputeLive: () => void
    chainRpc: (req: Record<string, unknown>) => Promise<Record<string, unknown>>
    factsBusy: boolean
    interruptPressedAtMs: number | null
    textRows?: unknown[]
  }
  const transcript = getTranscriptPath()
  const sid = path.basename(transcript, '.jsonl')
  const home = path.dirname(transcript)
  const connector = new DaemonSessionConnector({ sessionId: sid, home, workspaceId: '/tmp', title: 'rig', projectLabel: 'p' } as never)
  const g = connector as unknown as Guts
  let pressAnswer: Record<string, unknown> = { ok: true, outcome: 'applied' }
  g.chainRpc = () => Promise.resolve(pressAnswer)

  let clock = Date.now() - 60_000
  const feed = (tail: { text: string | null; messageId?: string; streamBlock?: 'text' | 'tool_use' }): void => {
    clock += 5
    publishSessionTail({ schema: 1, sessionId: sid, atMs: clock, text: tail.text, ...(tail.messageId !== undefined ? { messageId: tail.messageId } : {}), ...(tail.streamBlock !== undefined ? { streamBlock: tail.streamBlock, blockSinceMs: clock } : {}) } as never)
    g.readTail.call(connector)
  }
  const write = async (rows: unknown[]): Promise<void> => {
    await recordTranscript(rows as never)
    await flushSessionStorage()
    g.attached = true
    await g.tick.call(connector)
    g.attached = false
  }
  const busy = (on: boolean): void => {
    g.factsBusy = on
    g.recomputeLive.call(connector)
  }
  const press = async (): Promise<boolean> => {
    const took = connector.interrupt()
    await new Promise(resolve => setTimeout(resolve, 0))
    return took
  }
  const escaped = (text: string): string => JSON.stringify(text).slice(1, -1)
  const rowsWith = (text: string): unknown[] => connector.records().filter(row => JSON.stringify(row).includes(escaped(text)))
  const committed = (): number => (g.textRows ?? []).length
  const shown = (text: string): number =>
    rowsWith(text).length + ((connector.tail().read() ?? '').includes(text) ? 1 : 0) + ((connector.tail().readSettled() ?? '').includes(text) ? 1 : 0)
  const where = (text: string): string =>
    `rows=${rowsWith(text).length} committed=${committed()} tail=${JSON.stringify(connector.tail().read())} ghost=${JSON.stringify(connector.tail().readSettled())}`
  const isVirtual = (row: unknown): boolean => (row as { isVirtual?: boolean } | undefined)?.isVirtual === true
  const assistantWithId = (text: string, id: string): unknown => {
    const m = createAssistantMessage({ content: text }) as unknown as { message: Record<string, unknown> }
    return { ...m, message: { ...m.message, id } }
  }
  const markerRow = createUserInterruptionMessage({}) as unknown as { message: { content: Array<{ text: string }> } }
  const MARKER = markerRow.message.content[0]!.text

  section('C1 the cut reply at the press; its late clear under its own identity after the turn settled (the sighting)')
  const CUT = 'the half-written words of the cut reply'
  const X1 = 'msg_interrupt_tail_1'
  busy(true)
  feed({ text: 'the half-written', messageId: X1, streamBlock: 'text' })
  feed({ text: CUT, messageId: X1, streamBlock: 'text' })
  check('C1: the words stream in the tail before the press', connector.tail().read() === CUT && shown(CUT) === 1, where(CUT))
  check('C1: the press took (a turn was running)', await press())
  check('C1: at the press the words leave the screen — no tail, no ghost, no row', shown(CUT) === 0, where(CUT))
  feed({ text: `${CUT} and more after the press`, messageId: X1, streamBlock: 'text' })
  check('C1: words that arrive after the press never paint', shown(CUT) === 0, where(CUT))
  busy(false)
  check('C1: the latch released with the turn', g.interruptPressedAtMs === null)
  check('C1: the settled turn leaves none of the words behind', shown(CUT) === 0, where(CUT))
  await write([createUserMessage({ content: 'the next words' })])
  busy(true)
  feed({ text: null, messageId: X1 })
  check("C1 THE SIGHTING: the cut block's late clear under its own identity mints no row under the next words", shown(CUT) === 0 && committed() === 0, where(CUT))
  const NEXT = 'the next reply stands under the next words'
  const Y1 = 'msg_interrupt_tail_1b'
  feed({ text: NEXT, messageId: Y1, streamBlock: 'text' })
  check('C1: the next reply streams in the tail', connector.tail().read() === NEXT, where(NEXT))
  feed({ text: null, messageId: Y1, streamBlock: 'tool_use' })
  check('C1: its ended block stands as a committed row (the bridge is unchanged)', rowsWith(NEXT).length === 1 && committed() === 1, where(NEXT))
  await write([assistantWithId(NEXT, Y1)])
  check("C1: its record takes the row's place — the next reply paints once", shown(NEXT) === 1 && committed() === 0, where(NEXT))
  check('C1: and the cut words never came back', shown(CUT) === 0, where(CUT))
  busy(false)

  section("C2 the cut reply, then the turn's own clear (no identity) while the press still stands")
  const CUT2 = 'the second cut reply waits for its clear'
  const X2 = 'msg_interrupt_tail_2'
  busy(true)
  feed({ text: CUT2, messageId: X2, streamBlock: 'text' })
  await press()
  feed({ text: null })
  check("C2: the turn's clear mints no row of the cut words", rowsWith(CUT2).length === 0 && committed() === 0, where(CUT2))
  check('C2: and leaves no ghost', shown(CUT2) === 0, where(CUT2))
  busy(false)
  check('C2: nothing of it stands once the turn settled', shown(CUT2) === 0, where(CUT2))

  section('C3 a block of the cut turn that ended before the press (a committed row): it leaves with the press unless its record lands')
  const DONE3 = 'the block that ended before the tool call'
  const X3 = 'msg_interrupt_tail_3'
  busy(true)
  feed({ text: DONE3, messageId: X3, streamBlock: 'text' })
  feed({ text: null, messageId: X3, streamBlock: 'tool_use' })
  check('C3: the ended block stands as a committed row while its call writes the tool input', rowsWith(DONE3).length === 1 && committed() === 1, where(DONE3))
  await press()
  check('C3: the press retires the row whose record has not landed', shown(DONE3) === 0 && committed() === 0, where(DONE3))
  busy(false)
  check('C3: nothing of it stands once the turn settled', shown(DONE3) === 0, where(DONE3))
  await write([assistantWithId(DONE3, X3), createUserInterruptionMessage({})])
  const landed3 = rowsWith(DONE3)
  check('C3: when its record does land, the block paints once, from the record', shown(DONE3) === 1 && landed3.length === 1 && !isVirtual(landed3[0]), where(DONE3))

  section('C4 the transcript keeps the cut words (the abort-partial record): once, from the record, above the interrupt row')
  const KEPT = 'the cut words the transcript keeps'
  const X4 = 'msg_interrupt_tail_4'
  busy(true)
  feed({ text: KEPT, messageId: X4, streamBlock: 'text' })
  await press()
  await write([assistantWithId(KEPT, X4), createUserInterruptionMessage({})])
  feed({ text: null })
  busy(false)
  const kept = rowsWith(KEPT)
  check('C4: the kept words paint exactly once', shown(KEPT) === 1, where(KEPT))
  check('C4: the row is the record, never a minted copy', kept.length === 1 && !isVirtual(kept[0]), where(KEPT))
  const painted = connector.records().map(row => JSON.stringify(row))
  const keptAt = painted.findIndex(row => row.includes(escaped(KEPT)))
  const markerAt = painted.findIndex((row, i) => i > keptAt && row.includes(escaped(MARKER)))
  check('C4: the record stands above its interrupt row', keptAt !== -1 && markerAt > keptAt, `kept@${keptAt} marker@${markerAt}`)

  section('C5 a press the session refused: the reply keeps streaming and paints')
  const ON = 'the reply that kept streaming'
  const X5 = 'msg_interrupt_tail_5'
  busy(true)
  feed({ text: 'the reply that kept', messageId: X5, streamBlock: 'text' })
  pressAnswer = { ok: false, outcome: 'refused' }
  await press()
  pressAnswer = { ok: true, outcome: 'applied' }
  check('C5: the refused press leaves no latch', g.interruptPressedAtMs === null)
  feed({ text: ON, messageId: X5, streamBlock: 'text' })
  check("C5: the stream's words paint again", connector.tail().read() === ON, where(ON))
  feed({ text: null, messageId: X5, streamBlock: 'tool_use' })
  await write([assistantWithId(ON, X5)])
  check('C5: and land once', shown(ON) === 1 && committed() === 0, where(ON))
  busy(false)

  rmSync(configDir, { recursive: true, force: true })
  rmSync(daemonDir, { recursive: true, force: true })
  const restore = (key: 'MERCURY_CONFIG_DIR' | 'MERCURY_DAEMON_DIR' | 'MERCURY_HOME', value: string | undefined): void => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  restore('MERCURY_CONFIG_DIR', saved.config)
  restore('MERCURY_DAEMON_DIR', saved.daemon)
  restore('MERCURY_HOME', saved.home)
}

const ASK = 'stream slowly'
const SECOND_ASK = 'answer at once'
const FIRST_WORDS = 'the first slow reply'
const SECOND_WORDS = 'the reply stands here after its last item'
const THIRD_WORDS = 'the second slow reply'
const THIRD_FULL = 'the second slow reply follows the queued words'
const INTERRUPT_ROW = 'Interrupted · What should Mercury do instead?'
const CLOCK = /(\d\d:\d\d:\d\d) \[Mercury\] /

type Cell = { c: string; fg?: string; bg?: string }
type Mark = { label: string; atTick: number; grid: Cell[][] }
type Wire = { kind: string; n?: number; ask?: string; arm?: string; at: number }
type Rec = { recordId?: string; occurredAt?: string; actor?: { role?: string }; payload?: { kind?: string; content?: unknown } }
const rowText = (row: Cell[]): string => row.map(c => c.c || ' ').join('').replace(/\s+$/, '')
const gridText = (grid: Cell[][]): string => grid.map(rowText).join('\n')
const tail = (s: string): string => s.split('\n').slice(-14).join('\n')
const linesWith = (text: string, needle: string): string[] => text.split('\n').filter(l => l.includes(needle))
const indexWith = (lines: string[], needle: string, from = 0): number => lines.findIndex((l, i) => i >= from && l.includes(needle))
const recordText = (rec: Rec): string => {
  const content = rec.payload?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (block as { text?: unknown }).text)
    .filter((text): text is string => typeof text === 'string')
    .join('\n')
}
const parseRecord = (line: string): Rec | null => {
  if (line.trim() === '') return null
  try {
    return JSON.parse(line) as Rec
  } catch {
    return null
  }
}
const clockOf = (iso: string): string => {
  const d = new Date(iso)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

async function driveScene(route: 'openai' | 'anthropic', driver: AvailableCaptureDriver): Promise<void> {
  const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-interrupt-tail-${route}-${process.pid}`)
  const FIXTURE_CWD = path.join(RUN_HOME, 'fixture-repo')
  const PROBE_KEY = 'sk-ant-tail-probe-key'
  rmSync(RUN_HOME, { recursive: true, force: true })
  mkdirSync(FIXTURE_CWD, { recursive: true })
  writeFileSync(
    path.join(RUN_HOME, '.mercury.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme: 'dark',
      projects: { [FIXTURE_CWD]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
    }),
  )
  writeFileSync(path.join(RUN_HOME, 'settings.json'), JSON.stringify({}))
  writeFileSync(path.join(FIXTURE_CWD, 'README.md'), '# fixture\n')

  const captureFile = path.join(RUN_HOME, 'wire.jsonl')
  writeFileSync(captureFile, '')
  const fixture = spawn(BUN, ['run', FIXTURE, captureFile, FIXTURE_CWD], { stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const killer = setTimeout(() => reject(new Error('fixture never printed PORT')), 15_000)
    let buffer = ''
    fixture.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const m = /PORT (\d+)/.exec(buffer)
      if (m) {
        clearTimeout(killer)
        resolve(Number(m[1]))
      }
    })
    fixture.on('exit', code => reject(new Error(`fixture exited early (${code})`)))
  }).catch(err => {
    console.log(`FAIL ${String(err)}`)
    process.exit(1)
  })
  const base = `http://127.0.0.1:${port}`
  const reap = (): void => {
    fixture.kill('SIGTERM')
  }

  const model = route === 'openai' ? 'gpt-5.6-sol' : 'claude-opus-4-8'
  const out = path.join(RUN_HOME, 'grid.json')
  const sends: Array<Record<string, unknown>> = [
    { atTick: 60, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, minTick: 10, awaitText: '? for shortcuts', awaitSettleTicks: 2, data: `${ASK}\r` },
    { requireAwait: true, minTick: 5, awaitText: FIRST_WORDS, awaitSettleTicks: 1, data: '\x1b', mark: 'first-delta' },
    { requireAwait: true, minTick: 3, awaitText: INTERRUPT_ROW, awaitSettleTicks: 3, data: `${SECOND_ASK}\r`, mark: 'interrupted' },
    { requireAwait: true, minTick: 3, awaitText: SECOND_WORDS, awaitSettleTicks: 3, data: `${ASK}\r`, mark: 'second-landed' },
    { requireAwait: true, minTick: 3, awaitText: THIRD_WORDS, awaitSettleTicks: 1, data: '', mark: 'third-streaming' },
    { requireAwait: true, minTick: 3, awaitText: THIRD_FULL, awaitSettleTicks: 5, data: '', mark: 'third-landed' },
  ]
  for (let n = 1; n <= 6; n++) sends.push({ afterPrevTicks: 5, data: '', mark: `t+${n}` })
  const cfg = { argv: ['node', DIST, '--model', model], cwd: FIXTURE_CWD, sends, total: 220, cols: 120, rows: 40, out }
  const cfgPath = path.join(RUN_HOME, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(cfg))

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: RUN_HOME,
    ANTHROPIC_API_KEY: PROBE_KEY,
    ANTHROPIC_BASE_URL: base,
    OPENAI_API_KEY: 'sk-test-tail-openai',
    MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
    MERCURY_STREAM_IDLE_TIMEOUT_MS: '8000',
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CONNECTOR_TRACE: path.join(RUN_HOME, 'connector-trace.jsonl'),
    MERCURY_HEALTH_STATE_DIR: path.join(RUN_HOME, 'health-state'),
    MERCURY_DAEMON_DIR: path.join(RUN_HOME, 'daemon'),
    MERCURY_HOME: path.join(RUN_HOME, 'proof-home'),
  }
  delete childEnv.NODE_ENV
  delete childEnv.ANTHROPIC_AUTH_TOKEN

  const res = spawnSync(driver.python, [captureEngineEntry(driver, REPO), cfgPath], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(150_000),
    cwd: FIXTURE_CWD,
    env: childEnv,
  })
  reap()
  const marks: Mark[] = []
  let fin: Cell[][] = []
  if (existsSync(out)) {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Cell[][]; marks?: Mark[] }
    marks.push(...(payload.marks ?? []))
    fin = payload.grid
  }
  const wire: Wire[] = readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Wire)
  const frames = marks.map(m => ({ label: m.label, text: gridText(m.grid) }))
  const last = gridText(fin)

  const byRecord = new Map<string, Rec>()
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith('.jsonl')) {
        for (const line of readFileSync(p, 'utf8').split('\n')) {
          const rec = parseRecord(line)
          if (rec !== null) byRecord.set(rec.recordId ?? `${p}:${byRecord.size}`, rec)
        }
      }
    }
  }
  walk(path.join(RUN_HOME, 'projects'))
  const records = [...byRecord.values()]
  const replies = records.filter(rec => rec.actor?.role === 'assistant' && rec.payload?.kind === 'output' && recordText(rec).trim() !== '')
  const cutKept = replies.filter(rec => recordText(rec).includes(FIRST_WORDS)).length
  const markers = records.filter(rec => rec.payload?.kind === 'input' && recordText(rec).includes('[Request interrupted by user'))

  section(`${route} — T1/T2: the reply streamed; the interrupt row painted; the transcript the run wrote`)
  check(`${route}: vshot ran the journey as written`, res.status === 0, `status=${res.status} ${(res.stdout ?? '').split('\n').slice(-4).join(' | ')} ${(res.stderr ?? '').split('\n').slice(-3).join(' | ')}`)
  check(`${route}: the first reply streamed in the tail before esc`, frames.some(f => f.label === 'first-delta' && f.text.includes(FIRST_WORDS)), tail(frames[0]?.text ?? last))
  const interrupted = frames.find(f => f.label === 'interrupted')
  check(`${route}: the interrupt row painted once`, interrupted !== undefined && linesWith(interrupted.text, INTERRUPT_ROW).length === 1, tail(interrupted?.text ?? last))
  check(`${route}: the run wrote its transcript (the interrupt record and every reply)`, markers.length === 1 && replies.some(rec => recordText(rec).includes(SECOND_WORDS)) && replies.some(rec => recordText(rec).includes(THIRD_FULL)), `markers=${markers.length} replies=${JSON.stringify(replies.map(rec => recordText(rec).slice(0, 40)))}`)
  console.log(`  [info] ${route}: the transcript keeps the cut words in ${cutKept} record(s)`)

  section(`${route} — T3: from the interrupt on, the cut words stand exactly where the transcript puts them`)
  const afterInterrupt = [...frames.slice(Math.max(0, frames.findIndex(f => f.label === 'interrupted'))), { label: 'final', text: last }]
  const strays: string[] = []
  for (const frame of afterInterrupt) {
    const lines = frame.text.split('\n')
    const cut = lines.flatMap((l, i) => (l.includes(FIRST_WORDS) ? [i] : []))
    const row = indexWith(lines, INTERRUPT_ROW)
    if (cut.length !== cutKept) strays.push(`${frame.label}: ${cut.length} line(s) for ${cutKept} record(s): ${cut.map(i => lines[i]!.trim()).join(' || ')}`)
    else if (cut.some(i => row === -1 || i > row)) strays.push(`${frame.label}: below the interrupt row: ${cut.map(i => lines[i]!.trim()).join(' || ')}`)
  }
  check(`${route}: no frame paints the cut words where the transcript has none (and never under the interrupt row)`, strays.length === 0, strays.join('\n      '))

  section(`${route} — T4: the final grid is the transcript`)
  const lines = last.split('\n')
  const p1 = indexWith(lines, `❯ ${ASK}`)
  const cutRow = indexWith(lines, INTERRUPT_ROW)
  const p2 = indexWith(lines, `❯ ${SECOND_ASK}`)
  check(`${route}: the interrupt row stands once, between the cut prompt and the next prompt`, linesWith(last, INTERRUPT_ROW).length === 1 && p1 !== -1 && p1 < cutRow && cutRow < p2, `prompt@${p1} interrupt@${cutRow} next@${p2}\n${tail(last)}`)
  for (const rec of replies) {
    const words = recordText(rec).trim().split('\n')[0]!.trim()
    const showing = linesWith(last, words)
    const clocks = showing.map(l => CLOCK.exec(l)?.[1] ?? 'no clock')
    const want = clockOf(rec.occurredAt ?? '')
    check(`${route}: the reply "${words.slice(0, 32)}" stands once, wearing its own record's clock ${want}`, showing.length === 1 && clocks[0] === want, `${showing.length} line(s), clocks ${JSON.stringify(clocks)}`)
  }
  for (const words of [FIRST_WORDS, SECOND_WORDS, THIRD_FULL]) {
    const onScreen = linesWith(last, words).length
    const inRecords = replies.filter(rec => recordText(rec).includes(words)).length
    check(`${route}: "${words.slice(0, 32)}" — the grid shows it ${inRecords} time(s), as the transcript does`, onScreen === inRecords, `screen ${onScreen}, transcript ${inRecords}`)
  }

  section(`${route} — T5: every reply line wears a clock once the turns settled`)
  const settled = [...frames.filter(f => f.label.startsWith('t+')), { label: 'final', text: last }]
  const naked = settled.flatMap(f =>
    f.text
      .split('\n')
      .filter(l => (l.includes(FIRST_WORDS) || l.includes(SECOND_WORDS) || l.includes(THIRD_WORDS)) && !CLOCK.test(l))
      .map(l => `${f.label}: ${l.trim()}`),
  )
  check(`${route}: no naked copy of any reply`, naked.length === 0, naked.join('\n      '))

  section(`${route} — T6: the wire`)
  const asks = wire.filter(c => c.kind === route).map(c => ({ ask: c.ask ?? '', arm: c.arm ?? '' }))
  const asked = JSON.stringify(asks.map(a => `${a.arm}:${a.ask.slice(0, 40)}`))
  check(`${route}: the cut ask and the third ask each went out once (no reissue after the interrupt)`, asks.filter(a => a.arm === 'slow').length === 2 && asks.filter(a => a.ask === ASK).length === 2, asked)
  check(`${route}: the next ask rode behind the interruption and completed`, asks.some(a => a.ask.includes(SECOND_ASK) && a.arm === 'complete'), asked)

  if (failures === 0) rmSync(RUN_HOME, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${RUN_HOME}`)
}

console.log('============================================================')
console.log(" the interrupted turn's half-written text dies at the interrupt")
console.log('============================================================')
const only = (process.env.TAIL_SCENES ?? '').split(',').map(s => s.trim()).filter(s => s !== '')
const wants = (scene: string): boolean => only.length === 0 || only.includes(scene)
if (wants('connector')) await connectorScenes()
if (wants('openai') || wants('anthropic')) {
  if (!existsSync(DIST)) {
    console.log('FAIL dist/mercury.mjs missing — run `bun run build.ts` first (the drive proves the BUILT binary)')
    process.exit(1)
  }
  const driver = resolveCaptureDriver()
  if (driver.kind === 'unavailable') {
    console.log(`FAIL no capture driver: ${driver.reason} — ${driver.remedy}`)
    process.exit(1)
  }
  if (wants('openai')) await driveScene('openai', driver)
  if (wants('anthropic')) await driveScene('anthropic', driver)
}
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
