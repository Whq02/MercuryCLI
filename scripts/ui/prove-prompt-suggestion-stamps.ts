#!/usr/bin/env bun
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React, { useState } from 'react'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'suggestion-stamps-home-')))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.NODE_ENV = 'test'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)

const { usePromptSuggestion } = await import('../../src/hooks/usePromptSuggestion.js')
const { abortSpeculation, handleSpeculationAccept, isSpeculationEnabled, startSpeculation } = await import('../../src/services/PromptSuggestion/speculation.js')
const { AppStoreContext, IDLE_SPECULATION_STATE } = await import('../../src/state/AppState.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createStore } = await import('../../src/state/store.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { Box, EventEmitter, render, flushPendingSyncWork } = await import('../../src/ink.js')
type Api = ReturnType<typeof usePromptSuggestion>
type AppState = ReturnType<typeof getDefaultAppState>

let latest: Api | null = null
let setInput: ((value: string) => void) | null = null
let setResponding: ((value: boolean) => void) | null = null
function Probe(): React.ReactNode {
  const [inputValue, setInputValue] = useState('')
  const [isAssistantResponding, setIsAssistantResponding] = useState(false)
  setInput = setInputValue
  setResponding = setIsAssistantResponding
  latest = usePromptSuggestion({ inputValue, isAssistantResponding })
  return null
}
const settle = async (): Promise<void> => {
  for (let index = 0; index < 4; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}
const store = createStore(getDefaultAppState())
const emitter = new EventEmitter()
const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
const stream = new PassThrough()
stream.resume()
const stdout = Object.assign(stream, { columns: 80, rows: 24 }) as unknown as NodeJS.WriteStream
const stdinValue = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
const instance = await render(React.createElement(StdinContext.Provider, { value: stdinValue as never }, React.createElement(AppStoreContext.Provider, { value: store as never }, React.createElement(Box, null, React.createElement(Probe)))), { stdin, stdout, patchConsole: false, exitOnCtrlC: false })
await settle()
const api = (): Api => latest as Api
const record = () => store.getState().promptSuggestion
const seed = (text: string | null): void => { store.setState(prev => ({ ...prev, promptSuggestion: { text, promptId: text === null ? null : ('direct' as never), shownAt: 0, acceptedAt: 0, generationRequestId: text === null ? null : 'req_1' } })) }
const drive = async (action: (api: Api) => void): Promise<void> => { action(api()); await settle() }

section('§1 THE SUGGESTION — the record text, suppressed while the assistant responds or the input holds anything')
{
  check('no record text means no suggestion', api().suggestion === null)
  seed('run the tests')
  await settle()
  check('a seeded text is the suggestion', api().suggestion === 'run the tests', String(api().suggestion))
  setInput?.('r')
  await settle()
  check('a non-empty input suppresses it', api().suggestion === null)
  setInput?.('')
  setResponding?.(true)
  await settle()
  check('a responding assistant suppresses it', api().suggestion === null)
  setResponding?.(false)
  await settle()
  check('and it returns when both clear', api().suggestion === 'run the tests')
}

section('§2 THE STAMPS — shown first, accepted only after shown, each at most once and only with a text')
{
  const before = store.getState()
  await drive(a => a.markAccepted())
  check('accepting an unshown suggestion changes nothing (same state by identity)', store.getState() === before)
  await drive(a => a.markShown())
  const shownAt = record().shownAt
  check('showing stamps shownAt with the clock', shownAt > 0 && record().acceptedAt === 0, j(record()))
  const afterShown = store.getState()
  await drive(a => a.markShown())
  check('showing again is a no-op by identity', store.getState() === afterShown)
  await drive(a => a.markAccepted())
  check('accepting after showing stamps acceptedAt at or after shownAt', record().acceptedAt >= shownAt && record().shownAt === shownAt, j(record()))
  seed(null)
  await settle()
  const empty = store.getState()
  await drive(a => a.markShown())
  check('with no text neither stamp lands', store.getState() === empty)
}

section('§3 THE OUTCOME — a submission clears the record and aborts a speculation, unless the reset is skipped')
{
  seed('open the file')
  await settle()
  await drive(a => a.markShown())
  await drive(a => a.logOutcomeAtSubmission('open the file', { skipReset: true }))
  check('skipReset keeps the record', record().text === 'open the file' && record().shownAt > 0, j(record()))
  const stopped: string[] = []
  store.setState(prev => ({ ...prev, speculation: { status: 'active', id: 'spec_1', abort: () => { stopped.push('aborted') } } as never }))
  await drive(a => a.logOutcomeAtSubmission('open the file'))
  check('a submission clears the record to the empty shape', j(record()) === j({ text: null, promptId: null, shownAt: 0, acceptedAt: 0, generationRequestId: null }), j(record()))
  check('and stops the active speculation, leaving the shared idle value', j(stopped) === j(['aborted']) && store.getState().speculation === IDLE_SPECULATION_STATE)
  const cleared = j(record())
  await drive(a => a.logOutcomeAtSubmission('anything'))
  check('a second submission on a clear record leaves it clear', j(record()) === cleared && store.getState().speculation === IDLE_SPECULATION_STATE, j(record()))
}

section('§4 THE SPECULATION SURFACE — disabled, inert, and fail-open')
{
  check('speculation is not enabled', isSpeculationEnabled() === false)
  const before = store.getState()
  await startSpeculation('text', {}, updater => store.setState(updater as never), false, undefined)
  check('starting one changes no state', store.getState() === before)
  abortSpeculation(updater => store.setState(updater as never))
  check('aborting with nothing active is an identity update', store.getState() === before)
  store.setState(prev => ({ ...prev, speculation: { status: 'active', id: 'spec_2', abort: () => { throw new Error('thunk broke') } } as never }))
  abortSpeculation(updater => store.setState(updater as never))
  check('a throwing abort thunk is swallowed and the slice still goes idle', store.getState().speculation === IDLE_SPECULATION_STATE)
  seed('again')
  const answer = handleSpeculationAccept(IDLE_SPECULATION_STATE, 0, updater => store.setState(updater as never), 'again', undefined)
  check('the accept journey clears the record and asks for a query', answer.queryRequired === true && record().text === null, j([answer, record()]))
  const clear = store.getState()
  const again = handleSpeculationAccept(undefined, 0, updater => store.setState(updater as never), 'again', undefined)
  check('on a clear record it is an identity update and still asks for a query', again.queryRequired === true && store.getState() === clear)
  const failed = handleSpeculationAccept(null, 0, () => { throw new Error('store down') }, 'again', undefined)
  check('a throwing store fails open with a query required', failed.queryRequired === true)
}

instance.unmount()
instance.cleanup()
stream.destroy()
console.log(failures === 0 ? '\nPASS prompt suggestion stamps' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
