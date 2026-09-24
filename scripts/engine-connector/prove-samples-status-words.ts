#!/usr/bin/env bun
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import type { SeatStatusV1, SessionLiveV1 } from '../../src/services/engine-connector/seatLive.ts'
import type { SampleRowV1, WorkRowV1 } from '../../src/services/engine-connector/types.ts'

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const ROOT = resolve(argument('--root') ?? join(import.meta.dir, '../..'))
const frameDir = argument('--frames')
const scratchHome = process.env.MERCURY_CONFIG_DIR === undefined ? mkdtempSync(join(tmpdir(), 'samples-status-')) : null
if (scratchHome !== null) process.env.MERCURY_CONFIG_DIR = scratchHome
process.env.MERCURY_CREDENTIAL_STORE ??= 'file'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const src = (relative: string): string => join(ROOT, 'src', relative)
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8')
const { enableConfigs } = await import(src('utils/config.ts'))
enableConfigs()
const counts = await import(src('services/engine-connector/workCounts.ts'))
const bar = await import(src('components/SwitchboardTagBar.tsx'))
const work = await import(src('components/tasks/useFocusedWork.ts'))
const { IDLE_LIVE } = await import(src('services/engine-connector/seatLive.ts'))
const { noSessionConnector } = await import(src('services/engine-connector/noSessionConnector.ts'))
const slot = await import(src('services/engine-connector/focusedConnector.ts'))
const ink = await import(src('ink.ts'))
const { default: StdinContext } = await import(src('ink/components/StdinContext.ts'))
const { AppStoreContext } = await import(src('state/AppState.tsx'))
const { createStore } = await import(src('state/store.ts'))
const { getDefaultAppState } = await import(src('state/AppStateStore.ts'))
const React = (await import(Bun.resolveSync('react', join(ROOT, 'src')))).default

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

const t0 = 1_700_000_000_000
const rows: WorkRowV1[] = [
  ...[1, 2, 3, 4].map((n): WorkRowV1 => ({ id: `agent-${n}`, agentId: `agent-${n}`, kind: 'agent', name: `helper ${n}`, status: 'running', startTime: t0 + n, agentType: 'mercury-general' })),
  { id: 'shell-1', kind: 'shell', name: 'sleep 600', status: 'running', startTime: t0 + 9, command: 'sleep 600' },
]
const sample = (n: number): SampleRowV1 => ({ id: `sample-${n}`, title: `pricing table ${n}`, version: n, state: 'open', updatedAt: new Date(t0 + n).toISOString(), glyph: '⧉' })
const samples = (n: number): SampleRowV1[] => Array.from({ length: n }, (_, i) => sample(i + 1))
const waiting: SessionLiveV1 = { ...IDLE_LIVE, inFlight: true, phase: 'waiting', agentsWaiting: 4, waitingOn: counts.workCounts(rows), inProgressToolUseIDs: new Set<string>(), turnStartedAtMs: t0 }
const thinking: SessionLiveV1 = { ...waiting, phase: 'thinking', agentsWaiting: 0, waitingOn: undefined }
const status: SeatStatusV1 = { title: 'a chat', projectLabel: 'mercury', interrupting: false, hardStopping: false, wait: null, quietMs: 2_000, watchdogMs: 90_000, phaseMs: null, toolBudgetMs: null, stuck: false }
const OWNER = 'waiting on 4 agents · 1 shell · 1 sample'
const TODAY = 'waiting on 4 agents · 1 shell'
const composer = typeof bar.waitingStatusWords === 'function'
const spelling = typeof counts.withSampleWords === 'function'
const reader = typeof work.useFocusedSamples === 'function'
const tail = (line: string, n: number): string => (spelling ? counts.withSampleWords(line, samples(n)) : line)
const rowWords = (live: SessionLiveV1, n: number): string => tail(bar.statusLine(live, status), n)

section("S1 the row's words: the phase words, then the artifact tail — in every phase")
{
  check("statusLine speaks the phase words alone (the tail is the surface's, so waiting can never count twice)", bar.statusLine(waiting, status) === TODAY && !bar.statusLine(waiting, status).includes('sample'), bar.statusLine(waiting, status))
  check("waiting, one sample: the owner's exact string", rowWords(waiting, 1) === OWNER, rowWords(waiting, 1))
  check('waiting, zero samples: the line of today, no sample word', rowWords(waiting, 0) === TODAY && !rowWords(waiting, 0).includes('sample'), rowWords(waiting, 0))
  check('waiting, three samples pluralise', rowWords(waiting, 3) === 'waiting on 4 agents · 1 shell · 3 samples', rowWords(waiting, 3))
  check('waiting, two samples pluralise', rowWords(waiting, 2) === 'waiting on 4 agents · 1 shell · 2 samples', rowWords(waiting, 2))
  check('idle keeps the count: ready · 1 sample', tail(bar.restingStatusWords('', null), 1) === 'ready · 1 sample' && tail(bar.restingStatusWords('Opus 5', 'high'), 1) === 'ready · Opus 5 · high · 1 sample', tail(bar.restingStatusWords('', null), 1))
  check('thinking keeps the count beside the project, inventing no state word', rowWords(thinking, 1) === '1 sample' && bar.statusLine(thinking, status) === '', rowWords(thinking, 1))
  check('nothing plus nothing is nothing', tail('', 0) === '' && rowWords(thinking, 0) === '')
}

section('S2 one spelling, one boundary per surface')
{
  check('the tag bar exports the shared wait composer', composer)
  check("the spinner's waiting words equal the row's waiting words", composer && tail(bar.waitingStatusWords(waiting), 1) === OWNER && tail(bar.waitingStatusWords(waiting), 1) === rowWords(waiting, 1), composer ? tail(bar.waitingStatusWords(waiting), 1) : 'no composer')
  check('the sample word has one spelling', spelling && counts.withSampleWords('waiting on 1 shell', samples(1)) === 'waiting on 1 shell · 1 sample' && counts.withSampleWords('waiting on 1 shell', []) === 'waiting on 1 shell' && counts.withSampleWords('x', samples(2)) === 'x · 2 samples' && counts.withSampleWords('', samples(1)) === '1 sample', spelling ? 'spelled otherwise' : 'no spelling')
  check('the bare-count road carries the samples too', composer && tail(bar.waitingStatusWords({ ...waiting, waitingOn: undefined, agentsWaiting: 2 }), 1) === 'waiting on 2 agents · 1 sample' && tail(bar.waitingStatusWords({ ...waiting, waitingOn: undefined, agentsWaiting: 0 }), 1) === 'waiting on agents · 1 sample')
  check('a parked ask keeps its place; the artifact word is the tail', composer && tail(bar.waitingStatusWords({ ...waiting, waitingOn: { ...counts.workCounts(rows), asks: 1 } }), 1) === 'waiting on 4 agents · 1 shell · 1 ask · 1 sample')
  const tagBar = read('src/components/SwitchboardTagBar.tsx')
  const repl = read('src/screens/REPL.tsx')
  check('the row composes the tail exactly once, after every state decision', tagBar.split('withSampleWords(').length === 2 && tagBar.includes('const spoken = withSampleWords(words ?? line, samples)') && tagBar.indexOf('const spoken = withSampleWords(') > tagBar.indexOf('const held = receipt') && tagBar.includes('const fitted = fitStatusLine(spoken, columns, fixedWidth)'))
  check('the working strip composes the tail once over the shared wait composer', repl.includes("seatLive.phase === 'waiting' ? withSampleWords(waitingStatusWords(seatLive), focusedSamples) : null") && repl.split('withSampleWords(').length === 2)
  check('statusLine and the wait composer carry no sample of their own', /export function statusLine\(live: SessionLiveV1, s: SeatStatusV1, crew: CrewClockV1 \| null = null, compact = false\): string/.test(tagBar) && /export function waitingStatusWords\(live: SessionLiveV1\): string/.test(tagBar))
}

section('S3 samples are artifacts: never running work, never a busy session, never lost on a phase change')
{
  const counted = counts.workCounts(rows)
  check('the counting law never counts a sample', !('samples' in counted) && counts.workChipLine(counted) === '4 agents · 1 shell' && counts.workWaitingWords(counted) === TODAY)
  check('the live view and the counts carry no sample field', !read('src/services/engine-connector/seatLive.ts').includes('samples') && !read('src/services/engine-connector/workCounts.ts').includes('samples: number'))
  check('an idle seat stays idle: no esc clause, the plain way back, ready', !/\besc\b/.test(bar.escBackHint(IDLE_LIVE, status)) && bar.statusLine(IDLE_LIVE, status) === 'ready')
  check('the narrow compact arm keeps its concise work vocabulary', bar.statusLine(waiting, status, null, true) === 'waiting on background work')
  check('waiting → idle → thinking → waiting: the count rides every phase, once', rowWords(waiting, 1) === OWNER && tail(bar.restingStatusWords('', null), 1) === 'ready · 1 sample' && rowWords(thinking, 1) === '1 sample' && rowWords(waiting, 1).split('sample').length === 2)
}

section('S4 one truth: the seat projection the rail reads')
{
  const tagBar = read('src/components/SwitchboardTagBar.tsx')
  const repl = read('src/screens/REPL.tsx')
  const hook = read('src/components/tasks/useFocusedWork.ts')
  const tabs = read('src/components/mercury-ui/SessionTabs.tsx')
  const connector = read('src/services/engine-connector/daemonConnector.ts')
  check('the row reads the samples through the one roster reader', tagBar.includes('const samples = useFocusedSamples()'))
  check('the working strip reads the same reader', repl.includes('const focusedSamples = useFocusedSamples();') && repl.includes('focusedSamples,'))
  check("the reader is the focused connector's work roster — the projection the rail reads", hook.includes('export function useFocusedSamples(): readonly SampleRowV1[]') && hook.includes('getFocusedSessionConnector().workRoster().samples ?? []') && tabs.includes('useFocusedWorkRoster().samples ?? []'))
  check("the roster's samples are the seat facts' samples", connector.includes('const samples = this.facts?.samples ?? []'))
  check('neither road reads a samples store or directory of its own', !tagBar.includes('services/samples/') && !repl.includes('services/samples/') && !hook.includes('services/samples/') && !tagBar.includes('readdirSync'))
}

section('S5 the compact status row on the glass: phases and a hop')
const settle = async (): Promise<void> => {
  for (let index = 0; index < 6; index++) {
    ink.flushPendingSyncWork()
    await new Promise<void>(resolveTick => setTimeout(resolveTick, 5))
  }
}
type Seat = {
  setWork(next: { rows?: WorkRowV1[]; samples?: SampleRowV1[] }): void
  setLive(next: SessionLiveV1): void
}
function seatFixture(sessionId: string, initial: { live: SessionLiveV1; rows: WorkRowV1[]; samples: SampleRowV1[] }): Seat {
  const workListeners = new Set<() => void>()
  const liveListeners = new Set<() => void>()
  let roster = { rows: initial.rows, mission: [] as never[], samples: initial.samples, reported: true }
  let live = initial.live
  return Object.assign(Object.create(noSessionConnector()), {
    sessionId: () => sessionId,
    records: () => [],
    subscribeRecords: () => () => {},
    modelFacts: () => ({ effective: 'fixture-model', effectiveSource: 'live', main: 'fixture-model', setting: null, sessionPin: null, effort: null, effortSent: null, pendingSwitch: null }),
    subscribeModel: () => () => {},
    workRoster: () => roster,
    subscribeWork: (listener: () => void) => {
      workListeners.add(listener)
      return () => {
        workListeners.delete(listener)
      }
    },
    live: () => live,
    subscribeLive: (listener: () => void) => {
      liveListeners.add(listener)
      return () => {
        liveListeners.delete(listener)
      }
    },
    status: () => status,
    tail: () => ({ subscribe: () => () => {}, getSnapshot: () => null, read: () => null }),
    setWork(next: { rows?: WorkRowV1[]; samples?: SampleRowV1[] }): void {
      roster = { ...roster, rows: next.rows ?? roster.rows, samples: next.samples ?? roster.samples }
      for (const listener of workListeners) listener()
    },
    setLive(next: SessionLiveV1): void {
      live = next
      for (const listener of liveListeners) listener()
    },
  }) as Seat
}

async function mount(columns: number, element: unknown) {
  const emitter = new ink.EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows: 51 }) as unknown as NodeJS.WriteStream
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

const seatA = seatFixture('session-a', { live: waiting, rows, samples: [] })
const seatB = seatFixture('session-b', { live: waiting, rows, samples: [] })
const seatC = seatFixture('session-c', { live: IDLE_LIVE, rows: [], samples: samples(3) })
const waitingHint = bar.escBackHint(waiting, status)
const idleHint = bar.escBackHint(IDLE_LIVE, status)
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const idleLine = (count: string): RegExp => new RegExp(`^ ready · fixture-model(?: · [^·]+)? · ${count}\\s+${escaped(idleHint)}\\s*$`)
slot.setFocusedSessionConnector(seatA)
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
const row = await mount(178, React.createElement(bar.FocusedSessionStatusRow))
const scene = async (name: string, act: () => void): Promise<string> => {
  act()
  await settle()
  const frame = row.frame()
  if (frameDir !== undefined && !name.startsWith('again-')) writeFileSync(join(frameDir, `compact-status-178x51-${name}.txt`), `${frame}\n`)
  console.log(`  ${name}: ${JSON.stringify(frame.trimEnd())}`)
  return frame
}
const zero = await scene('1-waiting-zero-samples', () => {})
const one = await scene('2-waiting-one-sample', () => seatA.setWork({ samples: samples(1) }))
const idle = await scene('3-idle-one-sample', () => {
  seatA.setLive(IDLE_LIVE)
  seatA.setWork({ rows: [] })
})
const think = await scene('4-thinking-one-sample', () => seatA.setLive(thinking))
const again = await scene('again-waiting-one-sample', () => {
  seatA.setLive(waiting)
  seatA.setWork({ rows })
})
const hopZero = await scene('5-hop-waiting-zero-samples', () => slot.setFocusedSessionConnector(seatB))
const hopThree = await scene('6-hop-idle-three-samples', () => slot.setFocusedSessionConnector(seatC))
const back = await scene('again-back-waiting-one-sample', () => slot.setFocusedSessionConnector(seatA))
row.close()
const narrow = await mount(64, React.createElement(bar.FocusedSessionStatusRow))
const narrowFrame = narrow.frame()
narrow.close()
console.log(`  narrow 64: ${JSON.stringify(narrowFrame.trimEnd())}`)
{
  const all = [zero, one, idle, think, again, hopZero, hopThree, back]
  const squeeze = (frame: string): string => frame.trimEnd().replace(/ {2,}/g, ' ')
  check('every scene is one line within 178 columns and no render error', all.every(frame => frame !== '' && !frame.includes('\n') && stringWidth(frame) <= 178 && !frame.includes('ERROR')))
  check("waiting, one sample: the project, the owner's words, the way back", one.includes(` mercury · ${OWNER}`) && one.trimEnd().endsWith(waitingHint), one)
  check('waiting, zero samples: the row of today', zero.includes(` mercury · ${TODAY}`) && !zero.includes('sample') && zero.trimEnd().endsWith(waitingHint), zero)
  check('the sample word is the only difference; the way back keeps its column', squeeze(one.replace(' · 1 sample', '')) === squeeze(zero) && one.indexOf(waitingHint) === zero.indexOf(waitingHint), `${one.indexOf(waitingHint)} vs ${zero.indexOf(waitingHint)}`)
  check('a sample arriving repaints the mounted row through the roster feed', zero !== one)
  check('waiting → idle (the agents finished, their rows evicted): ready · … · 1 sample', idleLine('1 sample').test(idle), idle)
  check('idle → thinking: the count stands beside the project, no invented state word', think.includes(' mercury · 1 sample') && !/thinking|waiting|ready/.test(think) && think.trimEnd().endsWith(waitingHint), think)
  check("thinking → waiting: the owner's line again, the count once", again === one && again.split('sample').length === 2, again)
  check('a hop to a session with no samples drops the tail', hopZero.includes(` mercury · ${TODAY}`) && !hopZero.includes('sample'), hopZero)
  check('a hop to a session with three samples reads its own count', idleLine('3 samples').test(hopThree), hopThree)
  check("a hop back restores the first session's line", back === one, back)
  check('narrow: the way back survives and the sample word is the first cut', narrowFrame.trimEnd().endsWith(waitingHint) && stringWidth(narrowFrame) <= 64 && narrowFrame.includes('waiting on') && !narrowFrame.includes('1 sample'), narrowFrame)
}

section('S6 the root repaints for the artifact data it consumes, never for a runner tick')
{
  let renders = 0
  function Probe(): unknown {
    renders += 1
    const held = work.useFocusedSamples()
    return React.createElement(ink.Text, null, String(held.length))
  }
  if (reader) {
    const probe = await mount(40, React.createElement(Probe))
    const before = renders
    seatA.setWork({ rows: rows.map(r => ({ ...r, activity: 'reading a file' })) })
    await settle()
    const afterTick = renders
    seatA.setWork({ samples: samples(2) })
    await settle()
    const afterChange = renders
    const painted = probe.frame().trimEnd()
    probe.close()
    check('a runner tick that moves the rows but not the samples repaints nothing', afterTick === before, `${before} → ${afterTick}`)
    check('a sample change repaints, with the new count', afterChange > afterTick && painted === '2', `${afterTick} → ${afterChange} · ${JSON.stringify(painted)}`)
  } else {
    check('a runner tick that moves the rows but not the samples repaints nothing', false, 'no reader')
    check('a sample change repaints, with the new count', false, 'no reader')
  }
}
slot._resetFocusedSessionConnectorForTesting()
if (scratchHome !== null) rmSync(scratchHome, { recursive: true, force: true })

console.log(`\n ${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-samples-status-words: ALL LAWS HOLD' : `prove-samples-status-words: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
