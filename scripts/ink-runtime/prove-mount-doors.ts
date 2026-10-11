#!/usr/bin/env bun
// gate-watch: src/ink/root.ts src/ink/instances.ts
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mount-doors-home-'))
delete process.env.MERCURY_HOME

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const root = await import('../../src/ink/root.ts')
const instances = (await import('../../src/ink/instances.ts')).default
const { Text, flushPendingSyncWork } = await import('../../src/ink.ts')

const stdinStub = (): NodeJS.ReadStream =>
  Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setRawMode() { return this },
    setEncoding() { return this },
    read() { return null },
    unref() { return this },
    ref() { return this },
    pause() { return this },
    resume() { return this },
  }) as unknown as NodeJS.ReadStream
const screen = (): NodeJS.WriteStream => {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream & { columns?: number; rows?: number }
  stream.columns = 40
  stream.rows = 10
  stream.resume()
  return stream
}
const line = (text: string) => React.createElement(Text, null, text)

const frameMarks = (): { options: { onFrame: () => void }; painted: () => Promise<void>; count: () => number } => {
  const waiting: Array<() => void> = []
  let frames = 0
  return {
    options: {
      onFrame: () => {
        frames++
        waiting.splice(0).forEach(resolve => resolve())
      },
    },
    painted: () => {
      flushPendingSyncWork()
      return new Promise(resolve => waiting.push(resolve))
    },
    count: () => frames,
  }
}

section('§1 renderSync reuses the engine registered for a stream and forgets it on cleanup')
{
  const out = screen()
  const marks = frameMarks()
  const options = { stdout: out, stdin: stdinStub(), patchConsole: false, exitOnCtrlC: false, ...marks.options }
  const first = root.renderSync(line('one'), options)
  await marks.painted()
  const engine = instances.get(out)
  check('the mount registers an engine under its stdout', engine !== undefined)
  check("the engine's frame mark fired and the instance reads the frame it painted", marks.count() > 0 && first.lastFrame().includes('one'), first.lastFrame())
  const second = root.renderSync(line('two'), options)
  await marks.painted()
  check('a second mount on the same stream reuses the engine', instances.get(out) === engine)
  check('the second mount repainted through the same engine', second.lastFrame().includes('two') && first.lastFrame().includes('two'), second.lastFrame())
  first.rerender(line('three'))
  await marks.painted()
  check('rerender paints again', first.lastFrame().includes('three'), first.lastFrame())
  first.cleanup()
  check('cleanup forgets the registry entry', instances.get(out) === undefined)
  const third = root.renderSync(line('four'), options)
  await marks.painted()
  check('a mount after cleanup makes a fresh engine', instances.get(out) !== undefined && instances.get(out) !== engine)
  third.unmount()
  third.cleanup()
}

section('§2 the options: a bare stream as the options is the stdout; an options object fills its gaps')
{
  const bare = screen()
  const direct = root.renderSync(line('stream'), bare)
  check('a bare stream as the options mounts on that stream', instances.get(bare) !== undefined)
  direct.unmount()
  direct.cleanup()
  check('and cleanup forgets it', instances.get(bare) === undefined)
  const out = screen()
  const marks = frameMarks()
  const partial = root.renderSync(line('gaps'), { stdout: out, patchConsole: false, exitOnCtrlC: false, ...marks.options })
  await marks.painted()
  check('an options object without a stdin still mounts (the process stdin fills the gap) and its onFrame rides', instances.get(out) !== undefined && marks.count() > 0 && partial.lastFrame().includes('gaps'), partial.lastFrame())
  partial.unmount()
  partial.cleanup()
}

section('§3 createRoot always registers a fresh engine; the default render waits one microtask')
{
  const out = screen()
  const marks = frameMarks()
  const options = { stdout: out, stdin: stdinStub(), patchConsole: false, exitOnCtrlC: false, ...marks.options }
  const held = root.renderSync(line('held'), options)
  await marks.painted()
  const before = instances.get(out)
  const made = await root.createRoot(options)
  check('createRoot replaces the registered engine with a new one', instances.get(out) !== before && instances.get(out) !== undefined)
  made.render(line('root'))
  await marks.painted()
  check('the root renders through its own engine', (instances.get(out) as unknown as { lastFrameText(): string }).lastFrameText().includes('root'))
  made.unmount()
  held.cleanup()
  let settled = false
  const pending = root.default(line('later'), { stdout: screen(), stdin: stdinStub(), patchConsole: false, exitOnCtrlC: false }).then(instance => {
    settled = true
    instance.unmount()
    instance.cleanup()
  })
  check('the default render has not mounted synchronously', settled === false)
  await pending
  check('and resolves after the microtask boundary', settled === true)
}

console.log(failures === 0 ? '\nprove-mount-doors: ALL PASS' : `\nprove-mount-doors: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
