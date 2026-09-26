#!/usr/bin/env bun
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import type { WorkRowV1 } from '../../src/services/engine-connector/types.ts'

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const ROOT = resolve(argument('--root') ?? join(import.meta.dir, '../..'))
const frameDir = argument('--frames')
const scratch = mkdtempSync(join(tmpdir(), 'crew-pause-look-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const k of ['MERCURY_CRITTER_IDLE', 'MERCURY_CRITTER_GAZE', 'MERCURY_CRITTER_SLEEP', 'MERCURY_LIVE_CLOCK', 'MERCURY_LIVE_GLYPHS']) process.env[k] = '0'
delete process.env.MERCURY_CREW
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}

async function main(): Promise<void> {
  const src = (relative: string): string => join(ROOT, 'src', relative)
  const { enableConfigs } = await import(src('utils/config.ts'))
  enableConfigs()
  type GateModule = typeof import('../../src/run-core/pauseGate.ts')
  const gateModule: GateModule | null = await import(src('run-core/pauseGate.ts')).catch(() => null)
  type DoorModule = typeof import('../../src/components/mercury-ui/screens/crewPauseDoor.ts')
  const doorModule: DoorModule | null = await import(src('components/mercury-ui/screens/crewPauseDoor.ts')).catch(() => null)
  console.log(`  gate module: ${gateModule === null ? 'ABSENT (no src/run-core/pauseGate.ts)' : 'present'} · door module: ${doorModule === null ? 'ABSENT' : 'present'}`)
  const { noSessionConnector } = await import(src('services/engine-connector/noSessionConnector.ts'))
  const slot = await import(src('services/engine-connector/focusedConnector.ts'))
  const crew = await import(src('services/engine-connector/crewFacts.ts'))
  const { CrewView } = await import(src('components/mercury-ui/screens/CrewView.tsx'))
  const ink = await import(src('ink.ts'))
  const { default: StdinContext } = await import(src('ink/components/StdinContext.ts'))
  const { AppStoreContext } = await import(src('state/AppState.tsx'))
  const { createStore } = await import(src('state/store.ts'))
  const { getDefaultAppState } = await import(src('state/AppStateStore.ts'))
  const React = (await import(Bun.resolveSync('react', join(ROOT, 'src')))).default

  const t0 = Date.now() - 95_000
  writeFileSync(join(process.env.MERCURY_DAEMON_DIR!, 'concourse-workers.json'), JSON.stringify({ version: 1, workers: { 'concourse-w1': { schema: 1, runnerId: 'concourse-w1', sessionId: 'fx-session', workspaceId: ROOT, isolation: 'shared', modelKey: 'claude-fable-5-1', pid: process.pid, attachedAt: t0, startedAt: t0 } } }))

  const modelWords = gateModule === null ? undefined : gateModule.pauseGateModelWords()
  const toolWords = gateModule === null ? undefined : gateModule.pauseGateToolWords('Read')
  const running = (): WorkRowV1[] => [
    { id: 'ag-scout', agentId: 'ag-scout', kind: 'agent', name: 'scout the release notes', status: 'running', startTime: t0 + 1_000, agentType: 'mercury-general', model: 'claude-fable-5-1', inputTokens: 9_800, outputTokens: 2_500, contextTokens: 12_300, toolUses: 3, activity: 'reading docs/RELEASES.md' },
    { id: 'ag-reviewer', agentId: 'ag-reviewer', kind: 'agent', name: 'review the gate seams', status: 'running', startTime: t0 + 4_000, agentType: 'mercury-general', model: 'claude-opus-5-5', inputTokens: 4_100, outputTokens: 900, contextTokens: 5_000, toolUses: 1, activity: 'thinking' },
  ]
  const parked = (): WorkRowV1[] => running().map((row, i) => ({ ...row, activity: undefined, ...(i === 0 ? { wait: toolWords } : { wait: modelWords }) }))

  type Seat = { setWork(rows: WorkRowV1[]): void; setCarrier(carrier: 'daemon' | 'in-process'): void; pauseGateCalls: boolean[] }
  function seatFixture(rows: WorkRowV1[]): Seat {
    const listeners = new Set<() => void>()
    let roster: { rows: WorkRowV1[]; mission: never[]; samples: never[]; reported: boolean; pauseGate?: { paused: boolean; parked: number } } = { rows, mission: [] as never[], samples: [] as never[], reported: true }
    const publish = (): void => {
      for (const listener of listeners) listener()
    }
    const seat = Object.assign(Object.create(noSessionConnector()), {
      carrier: 'daemon',
      pauseGateCalls: [] as boolean[],
      sessionId: () => 'fx-session',
      records: () => [],
      subscribeRecords: () => () => {},
      workRoster: () => roster,
      subscribeWork: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      identity: () => ({ firstPartyApi: true, consoleBilling: false, claudeAiBilling: true, accountEmail: null }),
      spawnSwitches: () => ({ subagents: { on: true, source: 'default' }, workflows: { on: true, source: 'default' } }),
      async pauseGate(paused: boolean): Promise<{ outcome: 'applied'; detail: string }> {
        seat.pauseGateCalls.push(paused)
        roster = { ...roster, pauseGate: { paused, parked: 0 } }
        publish()
        return { outcome: 'applied', detail: JSON.stringify({ paused, parked: 0, changed: true }) }
      },
      setWork(next: WorkRowV1[]): void {
        roster = { ...roster, rows: next }
        publish()
      },
      setCarrier(carrier: 'daemon' | 'in-process'): void {
        seat.carrier = carrier
      },
    })
    return seat as Seat
  }

  const settle = async (): Promise<void> => {
    for (let index = 0; index < 6; index++) {
      ink.flushPendingSyncWork()
      await new Promise<void>(resolveTick => setTimeout(resolveTick, 5))
    }
  }
  async function mount(columns: number, rows: number) {
    const emitter = new ink.EventEmitter()
    const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
    const stream = new PassThrough()
    stream.resume()
    const stdout = Object.assign(stream, { columns, rows }) as unknown as NodeJS.WriteStream
    const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
    const store = createStore(getDefaultAppState())
    const node = React.createElement(StdinContext.Provider, { value: context }, React.createElement(AppStoreContext.Provider, { value: store }, React.createElement(CrewView, { onClose: () => {} })))
    let painted = (): void => {}
    const firstFrame = new Promise<void>(resolvePaint => { painted = resolvePaint })
    const instance = await ink.render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
    await firstFrame
    await settle()
    return {
      frame: (): string => stripAnsi(instance.lastFrame()).replace(/\n$/, ''),
      async key(name: string): Promise<void> {
        const event = new ink.InputEvent({ name, sequence: name, ctrl: false, shift: false, fn: false, meta: false, option: false, super: false, isPasted: false } as never)
        emitter.emit('input', event)
        await settle()
      },
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
  const fits = (frame: string, columns: number, rows: number): boolean => frame.split('\n').length <= rows && frame.split('\n').every(line => stringWidth(line) <= columns)

  section('L1 the row\'s words — a parked agent reads paused by the operator in its status cell, the seam and the door on its tail')
  {
    const facts = crew.crewAgentsOf(parked(), 'fx-session')
    const scout = facts.find(a => a.id === 'ag-scout')
    const reviewer = facts.find(a => a.id === 'ag-reviewer')
    check('both parked rows still count as running (the loop is alive, parked at a safe point — never a settled pause)', scout?.running === true && reviewer?.running === true && crew.crewCountLabel(facts).startsWith('2 running'), crew.crewCountLabel(facts))
    check('the status cell reads the gate words alone: paused by the operator', scout !== undefined && crew.crewStatusWords(scout, t0) === 'paused by the operator' && reviewer !== undefined && crew.crewStatusWords(reviewer, t0) === 'paused by the operator', `${scout === undefined ? '' : crew.crewStatusWords(scout, t0)} · ${reviewer === undefined ? '' : crew.crewStatusWords(reviewer, t0)}`)
    const parts = typeof crew.crewOperatorPauseParts === 'function' && scout !== undefined ? crew.crewOperatorPauseParts(scout) : null
    const modelParts = typeof crew.crewOperatorPauseParts === 'function' && reviewer !== undefined ? crew.crewOperatorPauseParts(reviewer) : null
    check('the tail names the seam it parked at (the tool (Read) on one row, the model call on the other) and the full sentence keeps the door: p resumes it', parts?.detail === 'at a tool (Read)' && modelParts?.detail === 'at a model call' && parts.door === 'p resumes it' && modelParts.door === 'p resumes it', `${JSON.stringify(parts)} · ${JSON.stringify(modelParts)}`)
    check('a seat wait is not an operator pause (the recogniser keys on the one spelling)', typeof crew.crewOperatorPauseParts === 'function' && crew.crewOperatorPauseParts({ running: true, wait: 'waiting for a seat — 3 of 3 held (agent-a, the chat)' }) === null)
    check('the chip words derive from the rows when the gate lives elsewhere: paused by the operator · 2 parked', typeof crew.crewPauseChipWords === 'function' && crew.crewPauseChipWords(facts, { paused: false, parked: 0 }) === 'paused by the operator · 2 parked' && crew.crewPauseChipWords(crew.crewAgentsOf(running(), 'fx-session'), { paused: false, parked: 0 }) === null)
  }

  section('L2 the view painted at 178x51 and 80x21 — running, then parked: the chip, the rows, the footer door')
  for (const [columns, rows] of [[178, 51], [80, 21]] as const) {
    const seat = seatFixture(running())
    slot.setFocusedSessionConnector(seat as never)
    const board = await mount(columns, rows)
    const live = board.frame()
    saveFrame(`crew-pause-${columns}x${rows}-running`, live)
    check(`${columns}x${rows} running: the view paints both rows inside the frame`, live.includes('scout the release') && live.includes('review the gate') && fits(live, columns, rows) && !live.includes('RENDER ERROR'), live.slice(0, 200))
    check(`${columns}x${rows} running: no chip, the footer offers p pause`, !live.includes('paused by the operator') && live.includes('p pause'), live.split('\n').at(-1))
    seat.setWork(parked())
    await settle()
    const paused = board.frame()
    saveFrame(`crew-pause-${columns}x${rows}-paused`, paused)
    check(`${columns}x${rows} parked: the chip reads [ paused by the operator · 2 parked ]`, paused.includes('[ paused by the operator · 2 parked ]'), paused.split('\n').slice(0, 8).join(' | '))
    check(`${columns}x${rows} parked: each row's status cell reads paused by the operator`, paused.split('\n').filter(line => line.includes('paused by the operator') && !line.includes('[ paused')).length === 2, paused)
    check(`${columns}x${rows} parked: the footer door turns to p resume`, paused.includes('p resume') && !paused.includes('p pause'), paused.split('\n').at(-1))
    if (columns === 178) check('178x51 parked: the tails name the seams whole (at a tool (Read) · at a model call) inside the row width', paused.includes('· at a tool (Read)') && paused.includes('· at a model call'), paused)
    check(`${columns}x${rows} parked: the frame still fits`, fits(paused, columns, rows))
    board.close()
    slot._resetFocusedSessionConnectorForTesting()
  }

  section('L3 the P key — a hosted session sends the verb through the connector and the chip reads the runner\'s fact; an in-process carrier toggles the local gate, the chip and the door follow')
  {
    const seat = seatFixture(running())
    slot.setFocusedSessionConnector(seat as never)
    const board = await mount(178, 51)
    await board.key('p')
    const hosted = board.frame()
    saveFrame('crew-pause-178x51-p-on-hosted', hosted)
    check("p on a daemon-hosted session: the press sends pauseGate(true) through the connector's door and the note says every loop parks", JSON.stringify(seat.pauseGateCalls) === '[true]' && doorModule !== null && hosted.includes(doorModule.CREW_PAUSED_NOTE.slice(0, 40)), `calls=${JSON.stringify(seat.pauseGateCalls)} · ${hosted.split('\n').filter(line => line.includes('·')).slice(-2).join(' | ')}`)
    check("p on a daemon-hosted session: the chip reads the runner's fact, never the face's own gate (which stays open), and the door reads p resume", hosted.includes('[ paused by the operator ]') && hosted.includes('p resume') && gateModule !== null && !gateModule.operatorPauseGate.paused(), hosted.split('\n').slice(0, 10).join(' | '))
    await board.key('p')
    const hostedResumed = board.frame()
    check('p again on the hosted session sends pauseGate(false): the chip goes, the note says resumed, the door reads p pause', JSON.stringify(seat.pauseGateCalls) === '[true,false]' && !hostedResumed.includes('[ paused by the operator') && doorModule !== null && hostedResumed.includes(doorModule.CREW_RESUMED_NOTE.slice(0, 30)) && hostedResumed.includes('p pause'), `calls=${JSON.stringify(seat.pauseGateCalls)} · ${hostedResumed.split('\n').slice(-3).join(' | ')}`)
    seat.setCarrier('in-process')
    await board.key('p')
    const pausedFrame = board.frame()
    saveFrame('crew-pause-178x51-p-in-process', pausedFrame)
    check('p with an in-process carrier closes the gate: the chip appears and the note says every loop parks', gateModule !== null && gateModule.operatorPauseGate.paused() && pausedFrame.includes('[ paused by the operator ]') && doorModule !== null && pausedFrame.includes(doorModule.CREW_PAUSED_NOTE.slice(0, 40)), pausedFrame.split('\n').slice(0, 10).join(' | '))
    check('the footer door reads p resume while the gate is closed', pausedFrame.includes('p resume'))
    await board.key('p')
    const resumedFrame = board.frame()
    check('p again opens the gate: the chip goes, the note says resumed, the door reads p pause', gateModule !== null && !gateModule.operatorPauseGate.paused() && !resumedFrame.includes('[ paused by the operator') && doorModule !== null && resumedFrame.includes(doorModule.CREW_RESUMED_NOTE.slice(0, 30)) && resumedFrame.includes('p pause'), resumedFrame.split('\n').slice(-3).join(' | '))
    board.close()
    slot._resetFocusedSessionConnectorForTesting()
  }

  section('L4 the source pins — the key is hosted beside x and r on a view with no text field; the words have one owner')
  {
    const { readFileSync } = await import('node:fs')
    const view = readFileSync(join(ROOT, 'src/components/mercury-ui/screens/CrewView.tsx'), 'utf8')
    check("the crew view hosts p in the same raw useInput as x and r (no text field on the view)", view.includes("if (input === 'p') {") && view.includes("if (input === 'x' && target !== null && target.running) {") && !/BaseTextInput|<TextInput\b/.test(view))
    check('the chip is the design-system Chip in the warn tone', view.includes('<Chip tone="warn">{pauseChip}</Chip>'))
    check('the row tail and the status cell read the one owner (crewFacts over the gate module)', view.includes('crewOperatorPauseParts(facts)') && readFileSync(join(ROOT, 'src/services/engine-connector/crewFacts.ts'), 'utf8').includes("from '../../run-core/pauseGate.js'"))
  }
}

await main()
console.log('─'.repeat(76))
console.log(failures === 0 ? `ALL PASS — ${checks} checks` : `FAILURES: ${failures} of ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
