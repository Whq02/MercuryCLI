import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import React, { useState } from 'react'
import Ink from '../../src/ink/ink.tsx'
import Text from '../../src/ink/components/Text.tsx'
import useInput from '../../src/ink/hooks/use-input.ts'
import instances from '../../src/ink/instances.ts'

class Output extends EventEmitter {
  isTTY = true
  columns = 80
  rows = 24
  write(): boolean { return true }
}
class Input extends EventEmitter {
  isTTY = true
  isRaw = false
  private chunks: string[] = []
  get readableLength(): number { return this.chunks.reduce((n, chunk) => n + chunk.length, 0) }
  setEncoding(): this { return this }
  setRawMode(value: boolean): this { this.isRaw = value; return this }
  ref(): this { return this }
  unref(): this { return this }
  pause(): this { return this }
  resume(): this { return this }
  read(): string | null { return this.chunks.shift() ?? null }
  push(data: string): void { this.chunks.push(data); this.emit('readable') }
}

const DOWN = '\x1b[B'
const ENTER = '\r'
const ROW = 'Crewmate default model'
const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function Scene({ log }: { log: string[] }): React.ReactElement {
  const [mode, setMode] = useState<'list' | 'search'>('list')
  const [query, setQuery] = useState('')
  const [row, setRow] = useState(0)
  useInput((input, key) => {
    if (mode === 'search') {
      if (key.return) { log.push(`select:${query}`); setMode('list'); return }
      if (input !== '' && !key.ctrl && !key.meta) { setQuery(q => q + input); log.push(`type:${input}`) }
      return
    }
    if (key.return) { log.push('close'); return }
    if (key.downArrow) { setRow(r => r + 1); log.push('down'); return }
    if (input !== '' && !key.ctrl && !key.meta) { setMode('search'); setQuery(input); log.push(`search:${input}`) }
  })
  return React.createElement(Text, null, `${mode} ${row} ${query}`)
}

async function scene(name: string, act: (stdin: Input) => Promise<void>): Promise<string[]> {
  const log: string[] = []
  const stdout = new Output()
  const stdin = new Input()
  const ink = new Ink({ stdout: stdout as never, stdin: stdin as never, stderr: new Output() as never, patchConsole: false, exitOnCtrlC: false })
  instances.set(stdout as never, ink)
  ink.render(React.createElement(Scene, { log }))
  await settle(150)
  await act(stdin)
  await settle(300)
  const exited = ink.waitUntilExit()
  ink.unmount()
  await exited
  instances.delete(stdout as never)
  console.log(`${name}: ${JSON.stringify(log)}`)
  return log
}

const downs = (stdin: Input, n: number): void => { for (let i = 0; i < n; i++) stdin.push(DOWN) }

const queued = await scene('eight downs queued, then the text, then Enter', async stdin => { downs(stdin, 8); stdin.push(ROW); stdin.push(ENTER) })
assert.equal(queued.filter(line => line === 'down').length, 8, 'every acting key dispatched')
assert.ok(!queued.includes('close'), 'the Enter behind a queued text batch must not run against the state before the text')
assert.ok(queued.includes(`select:${ROW}`), 'the Enter saw the text batch committed and selected the typed row')
console.log('PASS an acting key queued behind a text batch runs against the text batch\'s committed state')

const paused = await scene('the text, a pause, Enter', async stdin => { stdin.push(ROW); await settle(60); stdin.push(ENTER) })
assert.deepEqual(paused, [`search:${ROW}`, `select:${ROW}`])
console.log('PASS the text, a pause and the Enter select the typed row')

const oneChunk = await scene('the text and Enter in one chunk', async stdin => { stdin.push(ROW + ENTER) })
assert.deepEqual(oneChunk, [`search:${ROW}`, `select:${ROW}`])
console.log('PASS the text and the Enter in one chunk select the typed row')

const twoTexts = await scene('eight downs queued, then the text in two chunks, then Enter', async stdin => { downs(stdin, 8); stdin.push('Crewmate'); stdin.push(' default model'); stdin.push(ENTER) })
assert.ok(twoTexts.includes('type: default model'), 'the second text chunk typed into the search the first one opened')
assert.ok(twoTexts.includes(`select:${ROW}`), 'the query is both chunks, in order')
console.log('PASS consecutive text batches behind the queue each see the one before them committed')

console.log('INPUT DRAIN ORDER HOLDS')
process.exit(0)
