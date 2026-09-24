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

async function main(): Promise<void> {
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
  const statusWith = (over: Partial<SeatStatusV1>): SeatStatusV1 => ({ ...status, ...over })
  const OWNER = 'waiting on 4 agents · 1 shell · 1 sample'
  const TODAY = 'waiting on 4 agents · 1 shell'
  const composer = typeof bar.waitingStatusWords === 'function'
  const spelling = typeof counts.withSampleWords === 'function'
  const reader = typeof work.useFocusedSamples === 'function'
  const fitting = typeof bar.fitStatusWords === 'function' && typeof bar.statusLineBudget === 'function'
  const tail = (line: string, n: number): string => (spelling ? counts.withSampleWords(line, samples(n)) : line)
  const rowWords = (live: SessionLiveV1, n: number): string => tail(bar.statusLine(live, status), n)
  const fitWords = (line: string, n: number, columns: number, fixed: number): string =>
    fitting ? bar.fitStatusWords(line, samples(n), columns, fixed) : bar.fitStatusLine(tail(line, n), columns, fixed)
  const budgetOf = (columns: number, fixed: number): number => (fitting ? bar.statusLineBudget(columns, fixed) : Math.max(12, columns - fixed))

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

  section('S2 one spelling, one owner of the count on the wide layout')
  {
    check('the tag bar exports the shared wait composer', composer)
    check("the spinner's waiting words are the row's phase words; the row alone adds the tail", composer && bar.waitingStatusWords(waiting) === TODAY && !bar.waitingStatusWords(waiting).includes('sample') && tail(bar.waitingStatusWords(waiting), 1) === rowWords(waiting, 1), composer ? bar.waitingStatusWords(waiting) : 'no composer')
    check('the sample word has one spelling', spelling && counts.withSampleWords('waiting on 1 shell', samples(1)) === 'waiting on 1 shell · 1 sample' && counts.withSampleWords('waiting on 1 shell', []) === 'waiting on 1 shell' && counts.withSampleWords('x', samples(2)) === 'x · 2 samples' && counts.withSampleWords('', samples(1)) === '1 sample', spelling ? 'spelled otherwise' : 'no spelling')
    check('the bare-count road carries the samples too', composer && tail(bar.waitingStatusWords({ ...waiting, waitingOn: undefined, agentsWaiting: 2 }), 1) === 'waiting on 2 agents · 1 sample' && tail(bar.waitingStatusWords({ ...waiting, waitingOn: undefined, agentsWaiting: 0 }), 1) === 'waiting on agents · 1 sample')
    check('a parked ask keeps its place; the artifact word is the tail', composer && tail(bar.waitingStatusWords({ ...waiting, waitingOn: { ...counts.workCounts(rows), asks: 1 } }), 1) === 'waiting on 4 agents · 1 shell · 1 ask · 1 sample')
    const tagBar = read('src/components/SwitchboardTagBar.tsx')
    const repl = read('src/screens/REPL.tsx')
    const spokenAt = tagBar.indexOf('const spoken = withSampleWords(words ?? line, samples)')
    const heldAt = tagBar.indexOf('const held = receipt')
    check('the row composes the tail once, after every state decision, through the fit that protects the state words', tagBar.includes('const fitted = fitStatusWords(words ?? line, samples, columns, fixedWidth)') && spokenAt >= 0 && heldAt >= 0 && spokenAt > heldAt && !tagBar.includes('fitStatusLine(spoken'))
    check('the working strip speaks the shared wait composer and no sample of its own — the row under it is the owner', repl.includes("seatLive.phase === 'waiting' ? waitingStatusWords(seatLive) : null") && !repl.includes('withSampleWords(') && !repl.includes('useFocusedSamples'))
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
    check('the working strip reads no samples of its own', !repl.includes('useFocusedSamples') && !repl.includes('focusedSamples'))
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
    setStatus(next: SeatStatusV1): void
  }
  function seatFixture(sessionId: string, initial: { live: SessionLiveV1; rows: WorkRowV1[]; samples: SampleRowV1[] }): Seat {
    const workListeners = new Set<() => void>()
    const liveListeners = new Set<() => void>()
    let roster = { rows: initial.rows, mission: [] as never[], samples: initial.samples, reported: true }
    let live = initial.live
    let seatStatus = status
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
      status: () => seatStatus,
      tail: () => ({ subscribe: () => () => {}, getSnapshot: () => null, read: () => null }),
      setWork(next: { rows?: WorkRowV1[]; samples?: SampleRowV1[] }): void {
        roster = { ...roster, rows: next.rows ?? roster.rows, samples: next.samples ?? roster.samples }
        for (const listener of workListeners) listener()
      },
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
  if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
  const saveFrame = (columns: number, name: string, frame: string): void => {
    if (frameDir !== undefined) writeFileSync(join(frameDir, `compact-status-${columns}x51-${name}.txt`), `${frame}\n`)
    console.log(`  ${columns}: ${name}: ${JSON.stringify(frame.trimEnd())}`)
  }

  const seatA = seatFixture('session-a', { live: waiting, rows, samples: [] })
  const seatB = seatFixture('session-b', { live: waiting, rows, samples: [] })
  const seatC = seatFixture('session-c', { live: IDLE_LIVE, rows: [], samples: samples(3) })
  const waitingHint = bar.escBackHint(waiting, status)
  const idleHint = bar.escBackHint(IDLE_LIVE, status)
  const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const idleLine = (count: string): RegExp => new RegExp(`^ ready · fixture-model(?: · [^·]+)? · ${count}\\s+${escaped(idleHint)}\\s*$`)
  slot.setFocusedSessionConnector(seatA)
  const row = await mount(178, React.createElement(bar.FocusedSessionStatusRow))
  const scene = async (name: string | null, act: () => void): Promise<string> => {
    act()
    await settle()
    const frame = row.frame()
    if (name !== null) saveFrame(178, name, frame)
    return frame
  }
  const zero = await scene('1-waiting-zero-samples', () => {})
  const one = await scene('2-waiting-one-sample', () => seatA.setWork({ samples: samples(1) }))
  const idle = await scene('3-idle-one-sample', () => {
    seatA.setLive(IDLE_LIVE)
    seatA.setWork({ rows: [] })
  })
  const think = await scene('4-thinking-one-sample', () => seatA.setLive(thinking))
  const again = await scene(null, () => {
    seatA.setLive(waiting)
    seatA.setWork({ rows })
  })
  const hopZero = await scene('5-hop-waiting-zero-samples', () => slot.setFocusedSessionConnector(seatB))
  const hopThree = await scene('6-hop-idle-three-samples', () => slot.setFocusedSessionConnector(seatC))
  const back = await scene(null, () => slot.setFocusedSessionConnector(seatA))
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

  section('S6 the row repaints for the artifact data it consumes, never for a runner tick')
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

  section('S7 the tail never cuts the state words: a warning or a receipt keeps its own words; the count is the first thing dropped')
  const lateWait = { kind: 'first-byte' as const, cold: true, promptTokens: 26_000, model: 'Opus 5', budgetMs: 151_000, sinceMs: t0, attempt: 1 }
  const arms: Array<[string, SessionLiveV1, SeatStatusV1]> = [
    ['late first byte', thinking, statusWith({ wait: lateWait, quietMs: 160_000 })],
    ['stuck', thinking, statusWith({ stuck: true, quietMs: 45_000 })],
    ['interrupting', thinking, statusWith({ interrupting: true })],
    ['interrupting again', thinking, statusWith({ interrupting: true, hardStopping: true })],
  ]
  const receipts: Array<[string, string]> = [
    ['effort receipt', 'Effort set to high for this session — its next request runs it.'],
    ['effort receipt with the saved note', 'Effort set to high for this session — its next request runs it. Saved as your default for future sessions.'],
  ]
  const fixedFor = (live: SessionLiveV1, s: SeatStatusV1, words: boolean): number => (words ? 1 : 1 + stringWidth(status.projectLabel) + 3) + 2 + stringWidth(bar.escBackHint(live, s))
  const cases: Array<[string, string, number]> = [
    ...arms.map(([name, live, s]): [string, string, number] => [name, bar.statusLine(live, s), fixedFor(live, s, false)]),
    ...receipts.map(([name, text]): [string, string, number] => [name, text, fixedFor(IDLE_LIVE, status, true)]),
  ]
  const lawful: Record<string, string> = {}
  let tails = 0
  let fallbacks = 0
  for (const [name, line, fixed] of cases) {
    check(`${name}: the line carries a tail clause (the cut that protects it is the cut under proof)`, line.includes(' — ') && line !== '', line)
    for (const columns of [100, 120, 178]) {
      const base = bar.fitStatusLine(line, columns, fixed)
      const budget = budgetOf(columns, fixed)
      let ok = true
      let detail = ''
      for (const n of [1, 3]) {
        const got = fitWords(line, n, columns, fixed)
        const whole = tail(line, n)
        const holds = got === base || (got === whole && stringWidth(whole) <= budget)
        if (got === whole && whole !== base) tails += 1
        if (got === base) fallbacks += 1
        if (!holds) {
          ok = false
          detail = `${n}: ${got}`
        }
        lawful[`${name}@${columns}/${n}`] = got
      }
      check(`${name} @${columns}: the no-sample fit exactly, or the whole line with its tail — never a cut inside the state words`, ok, detail)
    }
  }
  check('the matrix exercises both arms (a tail that fits, and a fallback that drops it)', tails > 0 && fallbacks > 0, `tails=${tails} fallbacks=${fallbacks}`)
  const late = cases[0]![1]
  const stuck = cases[1]![1]
  const second = cases[3]![1]
  check("the reviewer's case: the late first-byte warning at 178 keeps '2m so far' and its whole head", lawful['late first byte@178/1'] === late && late.includes('2m so far') && !lawful['late first byte@178/1']!.includes('·…'), lawful['late first byte@178/1'])
  check("the reviewer's case: the stuck warning at 120 keeps 'for 45s'", lawful['stuck@120/1'] === stuck && stuck.includes('for 45s'), lawful['stuck@120/1'])
  check("the reviewer's case: the second esc at 100 reads exactly as it does without samples, its head surviving", lawful['interrupting again@100/1'] === bar.fitStatusLine(second, 100, cases[3]![2]) && lawful['interrupting again@100/1']!.startsWith('interrupt'), lawful['interrupting again@100/1'])
  check("the reviewer's case: the long effort receipt at 100 reads exactly as it does without samples", lawful['effort receipt with the saved note@100/1'] === bar.fitStatusLine(receipts[1]![1], 100, cases[5]![2]), lawful['effort receipt with the saved note@100/1'])
  seatA.setWork({ samples: samples(1) })
  const wide = await mount(178, React.createElement(bar.FocusedSessionStatusRow))
  const wideScene = async (name: string, act: () => void): Promise<string> => {
    act()
    await settle()
    const frame = wide.frame()
    saveFrame(178, name, frame)
    return frame
  }
  const lateFrame = await wideScene('7-late-first-byte-one-sample', () => {
    seatA.setLive(thinking)
    seatA.setStatus(arms[0]![2])
  })
  let receiptPainted = false
  const receiptFrame = await wideScene('8-receipt-one-sample', () => {
    seatA.setLive(IDLE_LIVE)
    seatA.setStatus(status)
    receiptPainted = bar.paintStatusRowReceipt(receipts[0]![1])
  })
  wide.close()
  seatA.setLive(thinking)
  const tight = await mount(100, React.createElement(bar.FocusedSessionStatusRow))
  const tightScene = async (name: string, act: () => void): Promise<string> => {
    act()
    await settle()
    const frame = tight.frame()
    saveFrame(100, name, frame)
    return frame
  }
  const stuckFrame = await tightScene('9-stuck-one-sample', () => seatA.setStatus(arms[1]![2]))
  const secondFrame = await tightScene('10-interrupting-again-one-sample', () => seatA.setStatus(arms[3]![2]))
  tight.close()
  seatA.setStatus(status)
  {
    const lateHint = bar.escBackHint(thinking, arms[0]![2])
    const secondHint = bar.escBackHint(thinking, arms[3]![2])
    check('every warning scene is one line within its width', [lateFrame, receiptFrame].every(frame => !frame.includes('\n') && stringWidth(frame) <= 178) && [stuckFrame, secondFrame].every(frame => !frame.includes('\n') && stringWidth(frame) <= 100))
    check('178, late first byte, one sample: the warning stands whole and the count yields', lateFrame.startsWith(` mercury · ${late}`) && !lateFrame.includes('sample') && lateFrame.trimEnd().endsWith(lateHint), lateFrame)
    check('178, a held receipt, one sample: the receipt whole, the count after its full stop', receiptPainted && receiptFrame.startsWith(` ${receipts[0]![1]} · 1 sample`) && receiptFrame.trimEnd().endsWith(idleHint), receiptFrame)
    check('100, stuck, one sample: the row reads exactly as it does without samples', stuckFrame.startsWith(` mercury · ${bar.fitStatusLine(stuck, 100, cases[1]![2])}`) && !stuckFrame.includes('sample') && stuckFrame.includes('the session may be stuck'), stuckFrame)
    check('100, the second esc, one sample: the row reads exactly as it does without samples', secondFrame.startsWith(` mercury · ${bar.fitStatusLine(second, 100, cases[3]![2])}`) && !secondFrame.includes('sample') && secondFrame.trimEnd().endsWith(secondHint), secondFrame)
  }
  slot._resetFocusedSessionConnectorForTesting()
}

try {
  await main()
} finally {
  if (scratchHome !== null) rmSync(scratchHome, { recursive: true, force: true })
}

console.log(`\n ${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-samples-status-words: ALL LAWS HOLD' : `prove-samples-status-words: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
