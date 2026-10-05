import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { decodePtyRecording, outputBursts, recordPty, type PtyRecord } from '../lib/ptyRecorder.ts'
import { ROOT, scratch } from './support.ts'

const work = scratch('pty-recorder-')
const path = join(work, 'bytes.bin')
const expected = Buffer.from([0, 255, 27, 91, 51, 49, 109, 65, 0xc3, 0xa9])
const recording = recordPty({
  argv: [join(ROOT, 'dist/vendor/node/bin/node'), '-e', 'process.stdin.setRawMode(true);process.stdout.write(Buffer.from([0,255,27,91,51,49,109,65,195,169]));process.stdin.once("data",bytes=>{process.stdout.write(bytes);process.exit(0)})'],
  cwd: ROOT, env: process.env, cols: 177, rows: 49, path,
})
try {
  const deadline = Date.now() + 10_000
  while (recording.records.length === 0) {
    assert.ok(Date.now() < deadline, 'the pty child never produced its ready bytes')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  const at = recording.send(Buffer.from([0x61, 0x00, 0x62]))
  assert.equal(await recording.exited, 0)
  const raw = readFileSync(path)
  const rows = decodePtyRecording(raw)
  assert.deepEqual(rows, recording.records)
  const output = Buffer.concat(rows.filter(row => row.direction === 'output').map(row => row.bytes))
  assert.deepEqual(output, Buffer.concat([expected, Buffer.from([0x61, 0x00, 0x62])]))
  assert.ok(rows.some(row => row.direction === 'input' && row.atMs === at))
  for (let index = 1; index < rows.length; index++) assert.ok(rows[index]!.atMs >= rows[index - 1]!.atMs)
  assert.throws(() => decodePtyRecording(raw.subarray(0, raw.length - 1)), /truncated/)
  const events: PtyRecord[] = [0, 3.9, 8, 12].map(atMs => ({ direction: 'output', atMs, bytes: Buffer.from('x') }))
  assert.deepEqual(outputBursts(events).map(burst => burst.length), [2, 2])
  console.log('[PASS] recorder: invalid UTF-8, NUL, ANSI and input bytes round-trip without decoding; timestamps are monotonic; burst boundary is 4ms; truncation refuses')
} finally {
  await recording.close()
  rmSync(work, { recursive: true, force: true })
}
