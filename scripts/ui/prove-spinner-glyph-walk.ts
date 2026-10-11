#!/usr/bin/env bun
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'glyph-walk-home-')))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.NODE_ENV = 'test'
process.env.FORCE_COLOR = '3'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)

const { SpinnerGlyph } = await import('../../src/components/Spinner/SpinnerGlyph.js')
const { getDefaultCharacters } = await import('../../src/components/Spinner/utils.js')
const { STILL_WAITING_MAX_INTENSITY } = await import('../../src/components/Spinner/useStalledAnimation.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { Box, EventEmitter, render, flushPendingSyncWork } = await import('../../src/ink.js')

const settle = async (): Promise<void> => {
  for (let index = 0; index < 4; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 4))
  }
}
const paint = async (props: Record<string, unknown>): Promise<{ raw: string; glyph: string }> => {
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns: 20, rows: 3, isTTY: true, hasColors: () => true, getColorDepth: () => 24 }) as unknown as NodeJS.WriteStream
  const stdinValue = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const instance = await render(React.createElement(StdinContext.Provider, { value: stdinValue as never }, React.createElement(Box, null, React.createElement(SpinnerGlyph, { messageColor: 'systemSpinner', ...props } as never))), { stdin, stdout, patchConsole: false, exitOnCtrlC: false })
  await settle()
  const raw = instance.lastFrame()
  instance.unmount()
  instance.cleanup()
  stream.destroy()
  return { raw, glyph: stripAnsi(raw).trim() }
}
const forward = getDefaultCharacters()
const frames = [...forward, ...[...forward].reverse()]
const glyphAt = async (frame: number, cadence = 'standard'): Promise<string> => (await paint({ frame, cadence })).glyph

section('§1 THE STANDARD WALK — the forward characters, then their reverse, then round again')
{
  const walked: string[] = []
  for (let frame = 0; frame < frames.length; frame++) walked.push(await glyphAt(frame))
  check('one full cycle walks every frame in order', j(walked) === j(frames), j(walked))
  check('the walk wraps', (await glyphAt(frames.length)) === frames[0] && (await glyphAt(frames.length + 3)) === frames[3])
}

section('§2 THE QUICKSILVER SWING — the bar holds its downbeat and rushes the back half, six frames per eight ticks')
{
  const swing: string[] = []
  for (let tick = 0; tick < 8; tick++) swing.push(await glyphAt(tick, 'quicksilver'))
  check('ticks 0 and 1 hold the downbeat; ticks 3 and 4 hold the next beat', swing[0] === swing[1] && swing[3] === swing[4] && swing[1] !== swing[2], j(swing))
  check('the eight ticks walk frames 0 0 1 2 2 3 4 5', j(swing) === j([0, 0, 1, 2, 2, 3, 4, 5].map(index => frames[index])), j(swing))
  check('the ninth tick starts the next bar six frames on', (await glyphAt(8, 'quicksilver')) === frames[6] && (await glyphAt(16, 'quicksilver')) === frames[12 % frames.length])
}

section('§3 REDUCED MOTION — one dot, dim on the second half of every two-second breath')
{
  const bright = await paint({ frame: 5, reducedMotion: true, time: 400 })
  const dim = await paint({ frame: 5, reducedMotion: true, time: 1400 })
  const brightAgain = await paint({ frame: 5, reducedMotion: true, time: 2300 })
  check('the dot paints whatever the frame', bright.glyph === '●' && dim.glyph === '●')
  check('the second half of the breath is dim, the first bright again', bright.raw !== dim.raw && bright.raw === brightAgain.raw, j([bright.raw, dim.raw]))
  check('the edges: 999 ms bright, 1000 ms dim', (await paint({ frame: 0, reducedMotion: true, time: 999 })).raw === bright.raw && (await paint({ frame: 0, reducedMotion: true, time: 1000 })).raw === dim.raw)
}

section('§4 THE ATTENTION EASE — the colour leaves the base as the intensity rises; the glyph does not change')
{
  const base = await paint({ frame: 2, attentionIntensity: 0 })
  const eased = await paint({ frame: 2, attentionIntensity: STILL_WAITING_MAX_INTENSITY / 2 })
  const full = await paint({ frame: 2, attentionIntensity: STILL_WAITING_MAX_INTENSITY })
  check('the glyph is the same at every intensity', base.glyph === eased.glyph && eased.glyph === full.glyph && base.glyph === frames[2])
  check('the painted colour moves with the intensity', base.raw !== eased.raw && eased.raw !== full.raw, j([base.raw, eased.raw, full.raw]))
}

console.log(failures === 0 ? '\nPASS spinner glyph walk' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
