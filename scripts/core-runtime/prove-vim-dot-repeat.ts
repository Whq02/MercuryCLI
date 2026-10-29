#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

const SCRATCH = mkdtempSync(join(tmpdir(), 'vim-dot-repeat-'))
process.env.MERCURY_CONFIG_DIR = SCRATCH
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const React = await import('react')
const { render, Text } = await import('../../src/ink.js')
const { default: useInput } = await import('../../src/ink/hooks/use-input.js')
const { useVimInput } = await import('../../src/hooks/useVimInput.js')
const { getSessionVimPersistentState } = await import('../../src/vim/types.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

const seen = { value: '', offset: 0, mode: 'INSERT' as string }

function Harness(): React.ReactElement {
  const [value, setValue] = React.useState('')
  const [offset, setOffset] = React.useState(0)
  const vim = useVimInput({ value, onChange: setValue, externalOffset: offset, onOffsetChange: setOffset, columns: 40 })
  useInput((input, key) => vim.onInput(input, key))
  seen.value = value
  seen.offset = offset
  seen.mode = vim.mode
  return React.createElement(Text, null, value || ' ')
}

const stdout = Object.assign(
  new Writable({
    write(_chunk: Buffer, _enc, cb) {
      cb()
    },
  }),
  { columns: 40, rows: 6, isTTY: false },
) as unknown as NodeJS.WriteStream
const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 60))
const type = async (bytes: string): Promise<void> => {
  ;(stdin as unknown as Readable).push(bytes)
  await settle()
}

getSessionVimPersistentState().lastChange = null
const h = React.createElement as (...a: unknown[]) => React.ReactElement
const instance = await render(
  h(AppStateProvider as never, {}, h(KeybindingSetup as never, {}, h(Harness))),
  { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
)
await settle()

console.log('§1 a dot with nothing recorded changes nothing')
await type('\u001b')
await type('.')
check('an empty draft in NORMAL stays empty after a dot', seen.value === '' && seen.mode === 'NORMAL', JSON.stringify(seen))

console.log('§2 a recorded insert replays at the cursor')
await type('i')
await type('abc')
await type('\u001b')
check('escape leaves NORMAL with the cursor one left of the end', seen.value === 'abc' && seen.offset === 2 && seen.mode === 'NORMAL', JSON.stringify(seen))
await type('.')
check('the dot re-inserts the recorded text at the cursor and moves past it', seen.value === 'ababcc' && seen.offset === 5, JSON.stringify(seen))

console.log('§3 a recorded x replays, and a replay records nothing')
await type('x')
check('x deletes the character under the cursor', seen.value === 'ababc', JSON.stringify(seen))
await type('.')
check('the dot deletes again', seen.value === 'abab', JSON.stringify(seen))
await type('.')
check('a second dot still replays the x (the replay recorded nothing new)', seen.value === 'aba', JSON.stringify(seen))

console.log('§4 a recorded operator over a motion replays')
await type('0')
await type('d')
await type('w')
check('dw at the start deletes the word', seen.value === '', JSON.stringify(seen))
await type('i')
await type('one two three four')
await type('\u001b')
await type('0')
await type('d')
await type('w')
check('dw at the start of the new draft deletes its first word', seen.value === 'two three four', JSON.stringify(seen))
await type('.')
check('the dot replays dw at the cursor', seen.value === 'three four', JSON.stringify(seen))
await type('.')
check('and once more', seen.value === 'four', JSON.stringify(seen))

instance.unmount()
rmSync(SCRATCH, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(` ✅ VIM DOT REPEAT GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ VIM DOT REPEAT RED (${failures} of ${checks} checks failed)`)
process.exit(1)
