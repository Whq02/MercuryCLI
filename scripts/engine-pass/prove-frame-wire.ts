import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lastFrameDelivery, writeDiffToTerminal } from '../../src/ink/session/delivery.ts'
import { _resetFrameTraceForTesting, readFrameTrace, readFrameWire, recordFrameTrace } from '../../src/ink/root/frame-trace.ts'
import { recordPty, sharedClockMs, type PtyRecord } from '../lib/ptyRecorder.ts'
import { buildScene } from './build-scene.ts'
import { ROOT, argument, scratch } from './support.ts'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const frameOf = (durationMs = 1) => ({ durationMs, flickers: [] as Array<{ reason: string }> })

console.log('\n§1 the trace row carries the bytes a frame put on the wire and the time they took to drain')
{
  _resetFrameTraceForTesting()
  let written = 0
  const prompt = { stdout: { write(data: string, done?: () => void) { written += Buffer.byteLength(data); done?.(); return true } }, stderr: { write() { return true } } }
  writeDiffToTerminal(prompt as never, [{ type: 'stdout', content: 'hello' }], true)
  const delivery = lastFrameDelivery()
  check('a write records its byte count from the serialized frame', delivery !== null && delivery.bytes === 5 && written === 5, JSON.stringify(delivery))
  check('a stream whose write callback fires at once carries its drain mark', delivery !== null && delivery.drainedAt !== null && delivery.drainedAt >= delivery.writtenAt)
  recordFrameTrace(frameOf())
  const wire = readFrameWire()
  check('the frame row reads wireBytes 5 and a non-negative drainMs', wire !== null && wire.wireBytes === 5 && wire.drainMs !== null && wire.drainMs >= 0, JSON.stringify(wire))
  const row = readFrameTrace()[0]!
  check('the row carries the fields beside the whole and the layout/paint split', 'wireBytes' in row && 'drainMs' in row && row.wireBytes === 5 && typeof row.paintMs === 'number' && typeof row.layoutMs === 'number')

  recordFrameTrace(frameOf())
  const silent = readFrameWire()
  check('a frame that wrote nothing reads 0 bytes and 0 ms, never the previous frame\'s bytes', silent !== null && silent.wireBytes === 0 && silent.drainMs === 0, JSON.stringify(silent))

  let release: (() => void) | null = null
  const slow = { stdout: { write(_data: string, done?: () => void) { release = done ?? null; return false } }, stderr: { write() { return true } } }
  writeDiffToTerminal(slow as never, [{ type: 'stdout', content: 'abc' }], true)
  recordFrameTrace(frameOf())
  const before = readFrameWire()
  check('a frame whose bytes have not drained reads drainMs null (never a guess)', before !== null && before.wireBytes === 3 && before.drainMs === null, JSON.stringify(before))
  check('the drain mark is the stream\'s own callback', release !== null)
  release!()
  const after = readFrameWire()
  check('the reader settles the drain from the callback mark without a timer', after !== null && after.drainMs !== null && after.drainMs >= 0, JSON.stringify(after))
  check('the ring row itself carries the settled drain', readFrameTrace()[2]!.drainMs === after!.drainMs)

  writeDiffToTerminal(prompt as never, [{ type: 'stdout', content: 'x' }], false)
  check('the synchronised-output markers count as wire bytes when they ride the frame', lastFrameDelivery()!.bytes === 1 + 2 * '\x1b[?2026h'.length)
  recordFrameTrace(frameOf())

  writeDiffToTerminal(prompt as never, [], true)
  recordFrameTrace(frameOf())
  check('an empty frame records no delivery: 0 bytes, 0 ms', readFrameWire()!.wireBytes === 0 && readFrameWire()!.drainMs === 0)
}

console.log('\n§2 on a terminal: every frame\'s wireBytes equals the bytes the pty recorder received, and the drain is read from the synchronous write\'s return')
if (process.argv.includes('--only-pure')) console.log('  [SKIP] the pty leg is not run with --only-pure')
else {
  const work = argument('--work-dir') ?? scratch('frame-wire-')
  mkdirSync(work, { recursive: true })
  const bundle = await buildScene(ROOT, join(work, 'wire-dist'), 'scripts/engine-pass/wire-scene.tsx')
  const scenes = join(import.meta.dir, 'scenes')
  const home = join(work, 'home')
  mkdirSync(home, { recursive: true })
  const timing = join(work, 'frames.jsonl')
  writeFileSync(timing, '')
  type Frame = { atMs: number; view: string; wire: { seq: number; wireBytes: number; drainMs: number | null } | null; phases?: { patches: number } }
  const readFrames = (): Frame[] => existsSync(timing) ? readFileSync(timing, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const env: Record<string, string | undefined> = { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal', COLORTERM: 'truecolor', FORCE_COLOR: '3', COLORFGBG: '15;0', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_CRITTER_SLEEP: '0' }
  for (const key of ['MERCURY_HOME', 'MERCURY_CRITTER', 'CI', 'NO_COLOR', 'TMUX', 'WT_SESSION']) delete env[key]
  const recording = recordPty({ argv: [join(ROOT, 'dist/vendor/node/bin/node'), bundle, scenes, timing], cwd: ROOT, env, cols: 177, rows: 49, path: join(work, 'pty.bin') })
  const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (predicate: () => boolean, label: string): Promise<void> => {
    const end = sharedClockMs() + 30_000
    while (!predicate()) {
      if (sharedClockMs() > end) throw new Error(`no ${label} within 30 seconds`)
      await delay(5)
    }
  }
  const inputs: number[] = []
  try {
    await until(() => readFrames().some(frame => frame.view === 'boot'), 'boot frame')
    recording.send('\r')
    await until(() => readFrames().some(frame => frame.view === 'chat'), 'chat frame')
    await delay(300)
    for (const key of 'wire bytes drain') {
      inputs.push(recording.send(key))
      await delay(120)
    }
    for (const sequence of ['\x1b[1;2D', '\x1b[1;2C', '\x1b[1;2D']) {
      inputs.push(recording.send(sequence))
      await delay(600)
    }
    await delay(300)
    const ended = sharedClockMs()
    const frames = readFrames()
    const bytesOf = (rows: readonly PtyRecord[]): number => rows.reduce((sum, row) => sum + row.bytes.length, 0)
    let compared = 0
    let agreed = 0
    let drained = 0
    const detail: string[] = []
    inputs.forEach((at, index) => {
      const end = inputs[index + 1] ?? ended
      const received = bytesOf(recording.records.filter(row => row.direction === 'output' && row.atMs >= at && row.atMs < end))
      const window = frames.filter(frame => frame.atMs >= at && frame.atMs < end && frame.wire !== null)
      const claimed = window.reduce((sum, frame) => sum + frame.wire!.wireBytes, 0)
      if (received === 0 && claimed === 0) return
      compared++
      if (claimed === received) agreed++
      else detail.push(`#${index} wire ${claimed} recorder ${received}`)
      if (window.every(frame => frame.wire!.wireBytes === 0 || (frame.wire!.drainMs !== null && frame.wire!.drainMs >= 0 && Number.isFinite(frame.wire!.drainMs)))) drained++
    })
    check(`every input window with bytes agrees: the frames' wireBytes equal the bytes the recorder received (${agreed}/${compared} windows)`, compared >= 10 && agreed === compared, detail.join(' · '))
    check('every frame that put bytes on the wire read a finite non-negative drainMs from the write\'s return', drained === compared, `${drained}/${compared}`)
    const full = frames.filter(frame => frame.wire !== null && frame.wire.wireBytes > 5000)
    check('the view switches put whole-screen frames on the wire with a measured drain', full.length >= 3 && full.every(frame => frame.wire!.drainMs !== null && frame.wire!.drainMs > 0), `${full.length} full frames: ${full.map(frame => `${frame.wire!.wireBytes} B in ${frame.wire!.drainMs?.toFixed(3)} ms`).join(', ')}`)
    recording.send('\x03')
    await until(() => readFrames().length >= frames.length, 'final frame')
  } finally {
    await recording.close()
    rmSync(home, { recursive: true, force: true })
  }
}

console.log(`\n${failures === 0 ? '[PASS]' : '[FAIL]'} frame wire: ${checks - failures}/${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
