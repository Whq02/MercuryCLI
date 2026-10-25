#!/usr/bin/env bun
import React from 'react'
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import type { ConcourseCallbacks, ConcourseSnapshotV1 } from '../../src/components/concourse/contracts.js'

process.env.NODE_ENV = 'test'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_LIVE_GLYPHS = '0'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const config = await import('../../src/utils/config.js')
config.enableConfigs()
const capacity = await import('../../src/services/switchboard/capacityCheck.js')
const capacityAnswers: boolean[] = []
const trustAnswers: string[] = []
let capacityNeeded = true
mock.module('../../src/services/switchboard/capacityCheck.js', () => ({
  ...capacity, needsCapacityAsk: () => capacityNeeded,
  recordCapacityDecision: async (allowed: boolean) => { capacityAnswers.push(allowed); return { recommendedSeats: 4 } },
}))
mock.module('../../src/utils/config.js', () => ({ ...config, isPathTrusted: () => false, setPathTrusted: (dir: string) => { trustAnswers.push(dir) } }))
const ink = await import('../../src/ink.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { ConcourseScreen, _resetConcourseCapsuleForTesting } = await import('../../src/components/concourse/ConcourseScreen.js')
const { resetOverlayStackForTests } = await import('../../src/context/overlayStack.js')
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) { ink.flushPendingSyncWork(); await new Promise<void>(resolve => setTimeout(resolve, 5)) }
}
let failures = 0
const warnings: string[] = []
const originalError = console.error
console.error = (...args: unknown[]): void => { warnings.push(args.map(String).join(' ')); originalError(...args) }
const check = (label: string, ok: boolean): void => { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`) }
const noop = (): void => {}
const callbacks: ConcourseCallbacks = {
  enterSession: noop, peekSession: noop, answerObligation: noop, openObligation: noop, claimObligation: noop,
  withdrawObligation: noop, pauseAfterTurn: noop, resumeSession: noop, redirectSession: noop, startSessionDraft: noop,
  setDraftSeed: noop, submitSessionDraft: noop, enterBootSettings: () => false, exitToChat: noop,
  switchCoordinatorModel: async value => ({ target: 'assist-model', value, outcome: 'no-change', inFlightTurns: 0, boundary: 'fixture' }),
  switchCoordinatorMode: async value => ({ target: 'mode', value, outcome: 'no-change', inFlightTurns: 0, boundary: 'fixture' }),
}
const snapshot: ConcourseSnapshotV1 = {
  schema: 1, revision: 1, clock: '00:00:00', context: { projectLabel: 'fixture', operatorHandle: 'operator' },
  breadcrumb: { active: 'concourse' }, coordinator: { mode: 'off' },
  focusedChat: { kind: 'non-model-controller', counted: false, submission: 'disabled-while-parked', reachedBy: 'esc' },
  counts: { live: 0, needsYou: 0, working: 0, queued: 0, seatsHeld: 0, seatsDenominator: 4, admission: 'fixed' },
  needsYou: [], groups: [], peek: null,
  newSession: { draft: '', seeds: { projectLabel: 'fixture', agentLabel: 'operator', modelLabel: 'fixture', modelId: 'fixture', modelIsDefault: true, effortLevel: 'high', effortIsDefault: true, isolation: 'exclusive', seatsMax: 1 } },
}
async function mount(node: React.ReactNode, initialState = getDefaultAppState()) {
  const emitter = new ink.EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() {}, setEncoding() {}, read() { return null }, unref() {}, ref() {}, pause() {}, resume() {} }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough(); stream.resume()
  const stdout = Object.assign(stream, { columns: 100, rows: 30 }) as unknown as NodeJS.WriteStream
  const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const body = React.createElement(StdinContext.Provider, { value: context }, React.createElement(AppStateProvider, { initialState, children:
    React.createElement(TerminalSizeContext.Provider, { value: { columns: 100, rows: 30 } }, node) }))
  let painted = (): void => {}
  const first = new Promise<void>(resolve => { painted = resolve })
  const instance = await ink.render(body, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await first; await settle()
  return {
    frame: () => stripAnsi(instance.lastFrame()),
    async key(name: string, modifiers: { ctrl?: boolean; meta?: boolean; super?: boolean } = {}): Promise<void> {
      emitter.emit('input', new ink.InputEvent({ name, sequence: name, ctrl: false, shift: false, fn: false, meta: false, option: false, super: false, isPasted: false, ...modifiers } as never))
      await settle()
    },
    close(): void { instance.unmount(); instance.cleanup(); stream.destroy(); resetOverlayStackForTests(); _resetConcourseCapsuleForTesting() },
  }
}
{
  const scene = await mount(React.createElement(ConcourseScreen, { snapshot, callbacks }))
  try {
    check('capacity card mounts', scene.frame().includes('FIRST BOOT'))
    for (const modifier of ['ctrl', 'meta', 'super'] as const) {
      await scene.key('y', { [modifier]: true })
      check(`${modifier}+y cannot consent to the capacity probe`, capacityAnswers.length === 0)
    }
    await scene.key('n')
    check('plain n declines the capacity probe', JSON.stringify(capacityAnswers) === '[false]')
  } finally { scene.close() }
}
capacityNeeded = false
{
  const target = '/fixture-untrusted-project'
  const doorSnapshot: ConcourseSnapshotV1 = { ...snapshot, groups: [{ id: 'elsewhere', label: 'OTHER PROJECTS', rows: [{ sessionId: 'door', title: 'other project', state: 'elsewhere', projectLabel: 'other', ownerLabel: null, ageLabel: null, seats: null, door: { kind: 'switch-project', dir: target, running: 1, needsYou: 0, finished: 0 } }] }] }
  const scene = await mount(React.createElement(ConcourseScreen, { snapshot: doorSnapshot, callbacks }))
  try {
    await scene.key('tab'); await scene.key('return')
    check('untrusted folder card mounts', scene.frame().includes('UNTRUSTED FOLDER'))
    for (const modifier of ['ctrl', 'meta', 'super'] as const) {
      await scene.key('y', { [modifier]: true })
      check(`${modifier}+y cannot grant folder trust`, trustAnswers.length === 0)
    }
    await scene.key('y')
    check('plain y grants the named folder once', JSON.stringify(trustAnswers) === JSON.stringify([target]))
  } finally { scene.close() }
}
{
  const daemonAnswers: boolean[] = []
  const scene = await mount(React.createElement(ConcourseScreen, { snapshot, callbacks: { ...callbacks, daemonOfferArmed: () => true, answerDaemonOffer: yes => { daemonAnswers.push(yes) } } }))
  try {
    for (const modifier of ['ctrl', 'meta', 'super'] as const) {
      await scene.key('y', { [modifier]: true })
      check(`${modifier}+y cannot start a daemon from its offer`, daemonAnswers.length === 0)
    }
    await scene.key('y')
    check('plain y accepts the daemon offer', JSON.stringify(daemonAnswers) === '[true]')
  } finally { scene.close() }
}
{
  const installed = await import('../../src/extensions/install.js')
  let removals = 0
  mock.module('../../src/extensions/install.js', () => ({
    ...installed,
    uninstallPreview: () => ({ version: '1.0', dataBytes: 12 }),
    uninstall: () => { removals++; return { ok: false, reason: 'fixture refused' } },
  }))
  type CapturedPane = { sections: Array<{ rows: unknown[] }>; rowActions: Array<{ key: string; run: (row: unknown) => void }>; composerSlot?: { active: boolean; onInput: (input: string, key: Record<string, boolean>) => void } }
  let pane: CapturedPane | null = null
  mock.module('../../src/components/mercury-ui/NavigablePanes.js', () => ({ NavigablePanes: (props: CapturedPane) => { pane = props; return React.createElement(ink.Text, null, 'extension fixture') } }))
  const { ExtensionsBoard } = await import('../../src/components/extensions/ExtensionsBoard.js')
  const state = getDefaultAppState()
  state.extensions = { ...state.extensions, roster: [{ id: 'fixture', name: 'fixture', label: 'source', version: '1.0', home: 'installed', pending: null, blockedBy: null, record: null, manifest: null, switchedOn: false, approved: false, availableVersion: null, shadowedBy: null, root: null } as never] }
  const scene = await mount(React.createElement(ExtensionsBoard, { route: { kind: 'board', section: 'installed' }, onClose: noop, appendTranscript: noop }), state)
  try {
    const current = (): CapturedPane => pane!
    current().rowActions.find(action => action.key === 'x')!.run(current().sections[0]!.rows[0])
    await settle()
    check('extension uninstall confirm arms', current().composerSlot?.active === true)
    for (const modifier of ['ctrl', 'meta', 'super'] as const) {
      current().composerSlot!.onInput('y', { [modifier]: true })
      await settle()
      check(`${modifier}+y cannot uninstall the extension`, removals === 0)
    }
    current().composerSlot!.onInput('y', {})
    await settle()
    check('plain y reaches the uninstall door once', removals === 1)
  } finally { scene.close() }
}
console.error = originalError
check('concourse list rows have stable React keys', !warnings.some(line => line.includes('unique "key"')))
console.log(`consent chords: ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
