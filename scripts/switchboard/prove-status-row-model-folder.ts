#!/usr/bin/env bun
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'status-row-model-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY ??= 'proof-key-ci-gate-not-a-real-key'
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

const FOLDER = 'orchard-kit'
const BRANCH = 'fix/status-row'
const MODEL_ID = 'claude-opus-5-5'

async function main(): Promise<void> {
  const src = (relative: string): string => join(ROOT, 'src', relative)
  const workspace = join(scratch, FOLDER)
  mkdirSync(join(workspace, '.git'), { recursive: true })
  writeFileSync(join(workspace, '.git', 'HEAD'), `ref: refs/heads/${BRANCH}\n`)
  const { enableConfigs } = await import(src('utils/config.ts'))
  enableConfigs()
  const bar = await import(src('components/SwitchboardTagBar.tsx'))
  const { keyHintLabel } = await import(src('components/mercury-ui/keyHintLabel.ts'))
  const { renderModelChip } = await import(src('utils/model/model.ts'))
  const { IDLE_LIVE } = await import(src('services/engine-connector/seatLive.ts'))
  const { noSessionConnector } = await import(src('services/engine-connector/noSessionConnector.ts'))
  const slot = await import(src('services/engine-connector/focusedConnector.ts'))
  const ink = await import(src('ink.ts'))
  const { default: StdinContext } = await import(src('ink/components/StdinContext.ts'))
  const { AppStoreContext } = await import(src('state/AppState.tsx'))
  const { createStore } = await import(src('state/store.ts'))
  const { getDefaultAppState } = await import(src('state/AppStateStore.ts'))
  const React = (await import(Bun.resolveSync('react', join(ROOT, 'src')))).default

  const MODEL = renderModelChip(MODEL_ID)
  const EFFORT = 'high'
  const BACK = keyHintLabel('⇧← back')
  const chordDelta = stringWidth(BACK) - stringWidth('⇧← back')
  const t0 = 1_700_000_000_000
  const rows: WorkRowV1[] = [
    ...[1, 2, 3].map((n): WorkRowV1 => ({ id: `agent-${n}`, agentId: `agent-${n}`, kind: 'agent', name: `helper ${n}`, status: 'running', startTime: t0 + n, agentType: 'mercury-crew' })),
    ...[1, 2, 3].map((n): WorkRowV1 => ({ id: `shell-${n}`, kind: 'shell', name: `sleep ${n}`, status: 'running', startTime: t0 + 10 + n, command: `sleep ${n}` })),
  ]
  const sample: SampleRowV1 = { id: 'sample-1', title: 'pricing table', version: 1, state: 'open', updatedAt: new Date(t0).toISOString(), glyph: '⧉' }
  const status: SeatStatusV1 = { title: 'a chat', projectLabel: FOLDER, interrupting: false, hardStopping: false, wait: null, quietMs: null, watchdogMs: null, phaseMs: null, toolBudgetMs: null, stuck: false } as SeatStatusV1
  const waiting: SessionLiveV1 = { ...IDLE_LIVE, inFlight: true, phase: 'waiting', waitingOn: { agents: 3, shells: 3 } } as SessionLiveV1
  const thinking: SessionLiveV1 = { ...IDLE_LIVE, inFlight: true, phase: 'thinking' } as SessionLiveV1

  type Seat = { setWork(next: { rows?: WorkRowV1[]; samples?: SampleRowV1[] }): void; setLive(next: SessionLiveV1): void; setStatus(next: SeatStatusV1): void }
  function seatFixture(initial: { live: SessionLiveV1; rows: WorkRowV1[]; samples: SampleRowV1[] }): Seat {
    const workListeners = new Set<() => void>()
    const liveListeners = new Set<() => void>()
    let roster = { rows: initial.rows, mission: [] as never[], samples: initial.samples, reported: true }
    let live = initial.live
    let seatStatus = status
    const facts = { cwd: workspace, originalCwd: workspace, projectRoot: workspace }
    return Object.assign(Object.create(noSessionConnector()), {
      sessionId: () => 'session-a',
      records: () => [],
      subscribeRecords: () => () => {},
      modelFacts: () => ({ effective: MODEL_ID, effectiveSource: 'live', main: MODEL_ID, setting: null, sessionPin: null, effort: EFFORT, effortSent: null, pendingSwitch: null }),
      subscribeModel: () => () => {},
      workspace: () => facts,
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

  const settle = async (): Promise<void> => {
    for (let index = 0; index < 6; index++) {
      ink.flushPendingSyncWork()
      await new Promise<void>(resolveTick => setTimeout(resolveTick, 5))
    }
  }
  async function mount(columns: number) {
    const emitter = new ink.EventEmitter()
    const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
    const stream = new PassThrough()
    stream.resume()
    const stdout = Object.assign(stream, { columns, rows: 51 }) as unknown as NodeJS.WriteStream
    const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
    const store = createStore(getDefaultAppState())
    const node = React.createElement(StdinContext.Provider, { value: context }, React.createElement(AppStoreContext.Provider, { value: store }, React.createElement(bar.FocusedSessionStatusRow)))
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
  const record = (columns: number, name: string, frame: string): string => {
    if (frameDir !== undefined) writeFileSync(join(frameDir, `status-row-${columns}x1-${name}.txt`), `${frame}\n`)
    console.log(`  ${columns}: ${name}: ${JSON.stringify(frame.trimEnd())}`)
    return frame
  }
  const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const RIGHT = `${FOLDER} ⌥ ${BRANCH}`
  const endsRight = (frame: string, right: string): boolean => new RegExp(`${escaped(right)} {2}(?:[^·]+ · )?${escaped(BACK)} ?$`).test(frame.trimEnd())
  const seat = seatFixture({ live: waiting, rows, samples: [] })
  slot.setFocusedSessionConnector(seat)

  section('§1 at 178 columns: the model and its effort in every state, the state words after them, the folder and branch at the right end')
  {
    const row = await mount(178)
    const scene = async (name: string, act: () => void): Promise<string> => {
      act()
      await settle()
      return record(178, name, row.frame())
    }
    const busy = await scene('busy', () => {})
    check('busy: the row leads with the model and its effort, then the activity words', busy.startsWith(` ${MODEL} · ${EFFORT} · waiting on 3 agents · 3 shells`), busy)
    check('busy: the project no longer leads the row (the folder lives at the right end)', !busy.startsWith(` ${FOLDER}`) && endsRight(busy, RIGHT), busy)
    const busySample = await scene('busy-sample', () => seat.setWork({ samples: [sample] }))
    check('busy with a sample: the count rides after the activity words', busySample.startsWith(` ${MODEL} · ${EFFORT} · waiting on 3 agents · 3 shells · 1 sample`) && endsRight(busySample, RIGHT), busySample)
    const resting = await scene('resting', () => {
      seat.setLive(IDLE_LIVE)
      seat.setWork({ rows: [], samples: [] })
    })
    check('resting: ready · the model · the effort, the folder and branch at the right end', resting.startsWith(` ready · ${MODEL} · ${EFFORT}  `) && endsRight(resting, RIGHT), resting)
    const thinkingFrame = await scene('thinking', () => seat.setLive(thinking))
    check('thinking (no crew): the model and effort stand alone on the left, no phase word', thinkingFrame.startsWith(` ${MODEL} · ${EFFORT}  `) && !/thinking|ready/.test(thinkingFrame) && endsRight(thinkingFrame, RIGHT), thinkingFrame)
    const warning = await scene('interrupting', () => {
      seat.setLive(IDLE_LIVE)
      seat.setStatus({ ...status, interrupting: true })
    })
    check('a warning: the model and effort stay, the warning after them', warning.startsWith(` ${MODEL} · ${EFFORT} · interrupting — the request is torn down`) && endsRight(warning, RIGHT), warning)
    const stuck = await scene('stuck', () => {
      seat.setStatus({ ...status, stuck: true, quietMs: 300_000, watchdogMs: 360_000 })
      seat.setLive(thinking)
    })
    check('the stuck verdict: the model and effort stay, the verdict after them', stuck.startsWith(` ${MODEL} · ${EFFORT} · no stream events for 5m — the session may be stuck (the watchdog aborts at 6m)`) && endsRight(stuck, RIGHT), stuck)
    const back = await scene('resting-again', () => {
      seat.setStatus(status)
      seat.setLive(IDLE_LIVE)
    })
    check('back to rest: ready leads again', back.startsWith(` ready · ${MODEL} · ${EFFORT}  `) && endsRight(back, RIGHT), back)
    row.close()
  }

  section('§2 the width law: the activity words truncate first, then the folder leaves, then the branch — never the model')
  {
    seat.setStatus(status)
    seat.setLive(waiting)
    seat.setWork({ rows, samples: [sample] })
    const shapes: Array<[number, string]> = []
    for (const nominal of [178, 120, 100, 90, 80, 72, 64, 56, 48]) {
      const columns = nominal + chordDelta
      const row = await mount(columns)
      const frame = record(columns, 'busy-width', row.frame())
      row.close()
      shapes.push([columns, frame])
      const trimmed = frame.trimEnd()
      check(`${columns}: one line within the width, the model and effort first, the way back last`, !frame.includes('\n') && stringWidth(trimmed) <= columns && trimmed.startsWith(` ${MODEL} · ${EFFORT}`) && trimmed.endsWith(BACK), frame)
    }
    const at = (nominal: number): string => shapes.find(s => s[0] === nominal + chordDelta)![1].trimEnd()
    check('178: everything fits — the full activity words, the sample, the folder and the branch', at(178).includes('waiting on 3 agents · 3 shells · 1 sample') && endsRight(at(178), RIGHT))
    check('120: everything still fits whole', at(120).includes('waiting on 3 agents · 3 shells · 1 sample') && endsRight(at(120), RIGHT), at(120))
    check('100: the activity words lose their sample word and cut first; the folder and branch stand', !at(100).includes('sample') && at(100).includes('…') && endsRight(at(100), RIGHT), at(100))
    check('90: the folder leaves next; the branch stands', !at(90).includes(FOLDER) && at(90).includes(`⌥ ${BRANCH}`), at(90))
    check('80: the branch leaves last; the activity words still stand whole', !at(80).includes(BRANCH) && !at(80).includes(FOLDER) && at(80).includes('waiting on 3 agents · 3 shells'), at(80))
    check('64: the model and effort and the way back stand; the activity words cut', !at(64).includes(BRANCH) && !at(64).includes(FOLDER) && at(64).startsWith(` ${MODEL} · ${EFFORT} · waiting`) && at(64).includes('…'), at(64))
    check('48: the model and effort still lead the row, the activity words cut to the floor', at(48).startsWith(` ${MODEL} · ${EFFORT}`) && at(48).endsWith(BACK), at(48))
    const planWide = bar.statusRowPlan({ columns: 178, head: `${MODEL} · ${EFFORT}`, rest: 'waiting on 3 agents · 3 shells', samples: [sample], folder: FOLDER, branch: BRANCH, backHint: BACK })
    const planNarrow = bar.statusRowPlan({ columns: 64, head: `${MODEL} · ${EFFORT}`, rest: 'waiting on 3 agents · 3 shells', samples: [sample], folder: FOLDER, branch: BRANCH, backHint: `esc interrupts · ${BACK}` })
    check('the plan is pure: wide keeps both, narrow sheds both', planWide.folderShown && planWide.branchShown && planWide.right === RIGHT && !planNarrow.folderShown && !planNarrow.branchShown && planNarrow.right === '', JSON.stringify([planWide, planNarrow]))
    const noBranch = bar.statusRowPlan({ columns: 178, head: `${MODEL} · ${EFFORT}`, rest: '', samples: [], folder: FOLDER, branch: null, backHint: BACK })
    check('no branch (a detached head, no repository): the folder stands alone', noBranch.right === FOLDER && noBranch.folderShown && !noBranch.branchShown)
  }

  section('§3 a held receipt: the model and effort stay, the receipt after them (eight seconds, then the resting words)')
  {
    seat.setStatus(status)
    seat.setLive(IDLE_LIVE)
    seat.setWork({ rows: [], samples: [] })
    const row = await mount(178)
    bar.paintStatusRowReceipt('Effort set to medium for this session')
    await settle()
    const held = record(178, 'receipt', row.frame())
    check('a held receipt: the model and effort stay, the receipt after them', held.startsWith(` ${MODEL} · ${EFFORT} · Effort set to medium for this session`) && endsRight(held, RIGHT), held)
    row.close()
  }

  section('§4 the words are pure and one spelling')
  {
    check('modelStatusWords: the model, the model and its effort, nothing without a model', bar.modelStatusWords('Opus 5.5', 'high') === 'Opus 5.5 · high' && bar.modelStatusWords('GLM-5.3', null) === 'GLM-5.3' && bar.modelStatusWords('', 'high') === '')
    check('restingStatusWords rides the same words', bar.restingStatusWords('Opus 5.5', 'high') === 'ready · Opus 5.5 · high' && bar.restingStatusWords('', null) === 'ready')
  }
}

try {
  await main()
} catch (error) {
  failures++
  console.log(`  [FAIL] render — ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`\nprove-status-row-model-folder: ${failures === 0 ? `GREEN (${checks} checks)` : `${failures} of ${checks} RED`}`)
process.exit(failures === 0 ? 0 : 1)
