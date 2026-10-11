#!/usr/bin/env bun
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'select-commit-home-')))
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

const { useSelectState } = await import('../../src/components/CustomSelect/use-select-state.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { Box, EventEmitter, render, flushPendingSyncWork } = await import('../../src/ink.js')
type State = ReturnType<typeof useSelectState<string>>

const heard: string[] = []
const focused: string[] = []
let latest: State | null = null
function Probe({ options, defaultValue, focusValue }: { options: { label: string; value: string }[]; defaultValue?: string; focusValue?: string }): React.ReactNode {
  latest = useSelectState<string>({ options, defaultValue, focusValue, onChange: value => { heard.push(value) }, onFocus: value => { focused.push(value) }, onCancel() {} })
  return null
}
const settle = async (): Promise<void> => {
  for (let index = 0; index < 4; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}
const mount = async (props: { options: { label: string; value: string }[]; defaultValue?: string; focusValue?: string }) => {
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns: 80, rows: 24 }) as unknown as NodeJS.WriteStream
  const stdinValue = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const instance = await render(React.createElement(StdinContext.Provider, { value: stdinValue as never }, React.createElement(Box, null, React.createElement(Probe, props))), { stdin, stdout, patchConsole: false, exitOnCtrlC: false })
  await settle()
  return { close() { instance.unmount(); instance.cleanup(); stream.destroy() } }
}
const state = (): State => latest as State
const drive = async (action: (state: State) => void): Promise<void> => { action(state()); await settle() }
const taken = (): string[] => heard.splice(0, heard.length)
const three = [{ label: 'Apples', value: 'apples' }, { label: 'Pears', value: 'pears' }, { label: 'Plums', value: 'plums' }]

section('§1 THE SEED — the value comes from the default; focus starts on the first option and is not a selection')
{
  const list = await mount({ options: three, defaultValue: 'pears' })
  check('the value is the default', state().value === 'pears', String(state().value))
  check('the opening focus is the first option, with no change fired', state().focusedValue === 'apples' && heard.length === 0, j([state().focusedValue, heard]))
  list.close()
}

section('§2 ENTER — the focused option becomes the value and onChange hears it')
{
  const list = await mount({ options: three })
  check('no default means no value', state().value === undefined)
  await drive(s => s.focusNextOption())
  await drive(s => s.selectFocusedOption())
  check('the second option is committed and announced once', state().value === 'pears' && j(taken()) === j(['pears']), j([state().value, heard]))
  await drive(s => s.selectFocusedOption())
  check('committing again announces again', j(taken()) === j(['pears']))
  list.close()
}

section('§3 A CLICK — the exact value is committed whatever the focus holds')
{
  const list = await mount({ options: three })
  await drive(s => s.selectValue('plums'))
  check('the clicked value is the value and the announcement', state().value === 'plums' && j(taken()) === j(['plums']), j([state().value, heard]))
  check('focus did not move with the click (the component moves it itself)', state().focusedValue === 'apples', String(state().focusedValue))
  list.close()
}

section('§4 NO FOCUS — an empty list commits nothing')
{
  const list = await mount({ options: [] })
  await drive(s => s.selectFocusedOption())
  check('with nothing focused the commit is a no-op', state().value === undefined && heard.length === 0, j([state().value, heard]))
  list.close()
}

console.log(failures === 0 ? '\nPASS select commit' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
