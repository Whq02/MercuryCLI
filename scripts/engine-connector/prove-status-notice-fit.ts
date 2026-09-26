#!/usr/bin/env bun
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import type { SeatStatusV1, SessionLiveV1 } from '../../src/services/engine-connector/seatLive.ts'
import type { RequestWaitV1 } from '../../src/services/providers/streamIdleBudget.ts'

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const ROOT = resolve(argument('--root') ?? join(import.meta.dir, '../..'))
const frameDir = argument('--frames')
const scratchHome = process.env.MERCURY_CONFIG_DIR === undefined ? mkdtempSync(join(tmpdir(), 'status-notice-fit-')) : null
if (scratchHome !== null) process.env.MERCURY_CONFIG_DIR = scratchHome
process.env.MERCURY_CREDENTIAL_STORE ??= 'file'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const PROJECT = 'fixture-repo'
const ELLIPSIS = '…'

async function main(): Promise<void> {
  const src = (relative: string): string => join(ROOT, 'src', relative)
  const { enableConfigs } = await import(src('utils/config.ts'))
  enableConfigs()
  const bar = await import(src('components/SwitchboardTagBar.tsx'))
  const { keyHintLabel } = await import(src('components/mercury-ui/keyHintLabel.ts'))
  const { IDLE_LIVE } = await import(src('services/engine-connector/seatLive.ts'))
  const { noSessionConnector } = await import(src('services/engine-connector/noSessionConnector.ts'))
  const slot = await import(src('services/engine-connector/focusedConnector.ts'))
  const ink = await import(src('ink.ts'))
  const { default: StdinContext } = await import(src('ink/components/StdinContext.ts'))
  const { AppStoreContext } = await import(src('state/AppState.tsx'))
  const { createStore } = await import(src('state/store.ts'))
  const { getDefaultAppState } = await import(src('state/AppStateStore.ts'))
  const React = (await import(Bun.resolveSync('react', join(ROOT, 'src')))).default

  const t0 = 1_700_000_000_000
  const thinking: SessionLiveV1 = { ...IDLE_LIVE, inFlight: true, phase: 'thinking', agentsWaiting: 0, inProgressToolUseIDs: new Set<string>(), turnStartedAtMs: t0 }
  const waiting: SessionLiveV1 = { ...thinking, phase: 'waiting', agentsWaiting: 4 }
  const resting: SeatStatusV1 = { title: 'hello sol', projectLabel: PROJECT, interrupting: false, hardStopping: false, wait: null, quietMs: null, watchdogMs: 3_000, phaseMs: null, toolBudgetMs: null, stuck: false }
  const statusWith = (over: Partial<SeatStatusV1>): SeatStatusV1 => ({ ...resting, ...over })
  const coldWait: RequestWaitV1 = { kind: 'first-byte', cold: true, promptTokens: 62_000, model: 'Opus 5', budgetMs: 78_000, sinceMs: t0, attempt: 1 }
  const warmWait: RequestWaitV1 = { kind: 'first-byte', cold: false, promptTokens: 900, model: 'Opus 5', budgetMs: 120_000, sinceMs: t0, attempt: 1 }
  const retryWait: RequestWaitV1 = { kind: 'retry', attempt: 2, of: 5, reason: 'a 529', delayMs: 8_000, sinceMs: t0 }
  const reconnectWait: RequestWaitV1 = { kind: 'retry', attempt: 1, of: 6, reason: 'network unreachable (ENETUNREACH)', delayMs: 2_000, sinceMs: t0 }
  const SENTENCE = 'ingesting a 62k-token prompt on Opus 5 — first byte expected within 1m 18s'
  const notices: Array<[string, SessionLiveV1, SeatStatusV1]> = [
    ['cold ingest', thinking, statusWith({ wait: coldWait })],
    ['cold ingest past its budget', thinking, statusWith({ wait: coldWait, quietMs: 95_000 })],
    ['warm first byte', thinking, statusWith({ wait: warmWait })],
    ['retry wait', thinking, statusWith({ wait: retryWait })],
    ['reconnect wait', thinking, statusWith({ wait: reconnectWait })],
    ['stuck', thinking, statusWith({ stuck: true, quietMs: 45_000, watchdogMs: 60_000 })],
    ['interrupting', thinking, statusWith({ interrupting: true })],
    ['interrupting again', thinking, statusWith({ interrupting: true, hardStopping: true })],
    ['waiting on agents', waiting, resting],
  ]

  section('S1 the words of every notice, pure: the ingest sentence is whole, and the fit rule keeps its tail clause')
  {
    const line = bar.statusLine(thinking, notices[0]![2])
    check('the cold ingest wait spells the prompt, the model and the budget, whole', line === SENTENCE, line)
    for (const [name, live, s] of notices) {
      const words = bar.statusLine(live, s)
      check(`${name}: the row has words`, words !== '', words)
    }
    const fixed = 1 + stringWidth(PROJECT) + 3 + 2 + stringWidth(bar.escBackHint(thinking, resting))
    check('at 150 columns the fit rule leaves the sentence untouched', bar.fitStatusLine(SENTENCE, 150, fixed) === SENTENCE, bar.fitStatusLine(SENTENCE, 150, fixed))
    const narrow = bar.fitStatusLine(SENTENCE, 60, fixed)
    check("at 60 columns the fit rule cuts with an ellipsis and keeps the budget clause's tail", narrow !== SENTENCE && narrow.includes(ELLIPSIS) && narrow.endsWith('1m 18s') && stringWidth(narrow) <= bar.statusLineBudget(60, fixed), narrow)
    const fixedOn = (platform: string): number => 1 + stringWidth(PROJECT) + 3 + 2 + stringWidth(keyHintLabel('esc interrupts · ⇧← back', platform))
    const offMacFixed = fixedOn('linux')
    const warm = bar.statusLine(thinking, notices[2]![2])
    const warmTail = warm.slice(warm.lastIndexOf(' — '))
    const floor = bar.fitStatusLine(warm, 60, offMacFixed)
    check('off-mac the way back spells shift+ and the 60-column fixed cells are five wider: the warm wait hits the budget floor and the ellipsis still leads its tail clause', offMacFixed === fixedOn('macos') + 5 && floor === `${ELLIPSIS}${warmTail}` && stringWidth(floor) === bar.statusLineBudget(60, offMacFixed), `${floor} (budget ${bar.statusLineBudget(60, offMacFixed)})`)
  }

  const settle = async (): Promise<void> => {
    for (let index = 0; index < 6; index++) {
      ink.flushPendingSyncWork()
      await new Promise<void>(resolveTick => setTimeout(resolveTick, 5))
    }
  }
  type Seat = { setLive(next: SessionLiveV1): void; setStatus(next: SeatStatusV1): void }
  function seatFixture(sessionId: string, initial: { live: SessionLiveV1; status: SeatStatusV1 }): Seat {
    const liveListeners = new Set<() => void>()
    const roster = { rows: [], mission: [], samples: [], reported: true }
    let live = initial.live
    let seatStatus = initial.status
    return Object.assign(Object.create(noSessionConnector()), {
      sessionId: () => sessionId,
      records: () => [],
      subscribeRecords: () => () => {},
      modelFacts: () => ({ effective: 'fixture-model', effectiveSource: 'live', main: 'fixture-model', setting: null, sessionPin: null, effort: null, effortSent: null, pendingSwitch: null }),
      subscribeModel: () => () => {},
      workRoster: () => roster,
      subscribeWork: () => () => {},
      live: () => live,
      subscribeLive: (listener: () => void) => {
        liveListeners.add(listener)
        return () => {
          liveListeners.delete(listener)
        }
      },
      status: () => seatStatus,
      tail: () => ({ subscribe: () => () => {}, getSnapshot: () => null, read: () => null }),
      setLive(next: SessionLiveV1): void {
        live = next
        for (const listener of liveListeners) listener()
      },
      setStatus(next: SeatStatusV1): void {
        seatStatus = next
        for (const listener of liveListeners) listener()
      },
    }) as Seat
  }

  async function mount(columns: number, rows: number, element: unknown) {
    const emitter = new ink.EventEmitter()
    const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
    const stream = new PassThrough()
    stream.resume()
    const stdout = Object.assign(stream, { columns, rows }) as unknown as NodeJS.WriteStream
    const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
    const store = createStore(getDefaultAppState())
    const node = React.createElement(StdinContext.Provider, { value: context }, React.createElement(AppStoreContext.Provider, { value: store }, element))
    let painted = (): void => {}
    const firstFrame = new Promise<void>(resolvePaint => { painted = resolvePaint })
    const instance = await ink.render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
    await firstFrame
    await settle()
    return {
      frame: (): string => stripAnsi(instance.lastFrame()).replace(/\n$/, ''),
      close(): void {
        instance.unmount()
        instance.cleanup()
        stream.destroy()
      },
    }
  }
  if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
  const saveFrame = (name: string, frame: string): void => {
    if (frameDir !== undefined) writeFileSync(join(frameDir, `${name}.txt`), `${frame}\n`)
  }
  const quote = (frame: string): string => JSON.stringify(frame.replace(/ {3,}/g, m => ` <${m.length} blank> `))

  type Painted = { row: string; hint: string; words: string }
  async function paint(columns: number, rows: number, name: string | null, scenes: Array<[string, SessionLiveV1, SeatStatusV1]>): Promise<Map<string, Painted>> {
    const seat = seatFixture(`session-${columns}`, { live: IDLE_LIVE, status: resting })
    slot.setFocusedSessionConnector(seat)
    const mounted = await mount(columns, rows, React.createElement(bar.FocusedSessionStatusRow))
    const out = new Map<string, Painted>()
    const rested = mounted.frame()
    check(`${columns}: the row rests before the turn (the drive's own starting frame)`, rested.trimStart().startsWith('ready') && !rested.includes(PROJECT), quote(rested))
    for (const [label, live, s] of scenes) {
      seat.setLive(live)
      seat.setStatus(s)
      await settle()
      const row = mounted.frame()
      if (name !== null) saveFrame(`${name}-${columns}x${rows}-${label.replace(/[^a-z0-9]+/g, '-')}`, row)
      out.set(label, { row, hint: bar.escBackHint(live, s), words: bar.statusLine(live, s) })
      seat.setLive(IDLE_LIVE)
      seat.setStatus(resting)
      await settle()
    }
    mounted.close()
    slot._resetFocusedSessionConnectorForTesting()
    return out
  }
  const rightEdge = (painted: Painted, columns: number): boolean => {
    const trimmed = painted.row.trimEnd()
    return trimmed.endsWith(painted.hint) && stringWidth(trimmed) === columns - 1 && !painted.row.includes('\n')
  }
  const cutBare = (painted: Painted): boolean => {
    const shown = painted.row.slice(` ${PROJECT} · `.length).split(/ {3,}/)[0] ?? ''
    return shown.length < painted.words.length && painted.words.startsWith(shown) && !shown.includes(ELLIPSIS)
  }
  const fixedOf = (painted: Painted): number => 1 + stringWidth(PROJECT) + 3 + 2 + stringWidth(painted.hint)
  const lawful = (label: string, painted: Painted, columns: number): void => {
    const fixed = fixedOf(painted)
    const fitted = bar.fitStatusLine(painted.words, columns, fixed)
    const whole = stringWidth(painted.words) <= bar.statusLineBudget(columns, fixed)
    const room = fixed + stringWidth(fitted) <= columns
    const detail = `${quote(painted.row)} fitted=${JSON.stringify(fitted)}`
    if (whole) check(`${label} @${columns}: the words paint whole, the way back at the right edge`, painted.row.startsWith(` ${PROJECT} · ${painted.words}`) && !painted.row.includes(ELLIPSIS) && rightEdge(painted, columns), detail)
    else if (room) check(`${label} @${columns}: the rule's own cut (an ellipsis, the tail clause kept), the way back at the right edge`, painted.row.startsWith(` ${PROJECT} · ${fitted}`) && fitted.includes(ELLIPSIS) && fitted.endsWith(painted.words.slice(-4)) && rightEdge(painted, columns), detail)
    else check(`${label} @${columns}: no room beside the fixed cells — the row's own end cut marks the cut and keeps the way back`, painted.row.startsWith(` ${PROJECT.slice(0, 3)}`) && painted.row.includes(ELLIPSIS) && rightEdge(painted, columns), detail)
    check(`${label} @${columns}: never a bare cut, within the width, one line`, !cutBare(painted) && stringWidth(painted.row) <= columns && !painted.row.includes('\n'), quote(painted.row))
  }

  section('S2 at 150 columns the cold ingest sentence paints whole after the resting row, the way back at the right edge')
  const wide = await paint(150, 34, 'status-row', notices)
  {
    const cold = wide.get('cold ingest')!
    check('the row reads the project, the separator and the whole sentence', cold.row.startsWith(` ${PROJECT} · ${SENTENCE}`), quote(cold.row))
    check('no bare cut: the words are never followed by blank columns before the way back', !cutBare(cold), quote(cold.row))
    check("the way back carries the esc clause and stands at the right edge", cold.hint === keyHintLabel('esc interrupts · ⇧← back') && rightEdge(cold, 150), quote(cold.row))
    for (const [label] of notices) lawful(label, wide.get(label)!, 150)
  }

  section("S3 at 60 columns every notice is cut by the fit rule (an ellipsis, the tail clause kept) or the row's own end cut — never a bare cut")
  const tight = await paint(60, 21, 'status-row', notices)
  {
    const cold = tight.get('cold ingest')!
    const fitted = bar.fitStatusLine(SENTENCE, 60, fixedOf(cold))
    check("the cold ingest sentence takes the rule's cut: an ellipsis, the budget's tail kept", cold.row.startsWith(` ${PROJECT} · ${fitted}`) && fitted !== SENTENCE && fitted.includes(ELLIPSIS) && fitted.endsWith('1m 18s'), `${quote(cold.row)} fitted=${JSON.stringify(fitted)}`)
    for (const [label] of notices) lawful(label, tight.get(label)!, 60)
  }

  section('S4 the frames at 178x51 and 80x21: the sentence whole where there is room, the rule where there is not')
  {
    const cold = notices.slice(0, 1)
    const roomy = (await paint(178, 51, 'status-row', cold)).get('cold ingest')!
    check('178: the sentence whole, the way back at the right edge', roomy.row.startsWith(` ${PROJECT} · ${SENTENCE}`) && rightEdge(roomy, 178), quote(roomy.row))
    const small = (await paint(80, 21, 'status-row', cold)).get('cold ingest')!
    const fixed = 1 + stringWidth(PROJECT) + 3 + 2 + stringWidth(small.hint)
    const fitted = bar.fitStatusLine(SENTENCE, 80, fixed)
    check("80: the rule's cut (the ellipsis, the budget kept), the way back at the right edge", small.row.startsWith(` ${PROJECT} · ${fitted}`) && fitted.includes(ELLIPSIS) && fitted.endsWith('1m 18s') && rightEdge(small, 80), `${quote(small.row)} fitted=${JSON.stringify(fitted)}`)
  }
}

try {
  await main()
} finally {
  if (scratchHome !== null) rmSync(scratchHome, { recursive: true, force: true })
}

console.log(`\n ${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-status-notice-fit: ALL LAWS HOLD' : `prove-status-notice-fit: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
