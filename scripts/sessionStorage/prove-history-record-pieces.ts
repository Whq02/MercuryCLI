#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { appendFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchRoot } from '../engine-durability/harness.ts'

const home = scratchRoot('history-pieces')
const file = join(home, 'history.jsonl')
const { nodeTranscriptReaderIo, setTranscriptReaderIoForTesting, transcriptLineBytes } = await import('../../src/utils/sessionStorage/transcriptBytes.ts')
const { openWorkerTranscript, readAfterCursor } = await import('../../src/services/concourse/workerTranscript.ts')
const { openInitialWorkerTranscript, mergeFoldedMessages } = await import('../../src/components/concourse/workerTranscriptFold.ts')
const lines = (pieceBytes: number) => Array.from(transcriptLineBytes(file, { pieceBytes }), bytes => bytes.toString('utf8'))
try {
  const part = Buffer.from('{"text":"☃"}\n')
  const split = part.indexOf(Buffer.from('☃')) + 1
  writeFileSync(file, part.subarray(0, split))
  const first = openWorkerTranscript(file)
  assert.deepEqual(first.records, [])
  appendFileSync(file, part.subarray(split))
  const second = readAfterCursor(first.cursor)
  assert.deepEqual(second.records, [{ text: '☃' }], 'the cursor must resume at the unfinished UTF-8 character without replacement')
  writeFileSync(file, '')
  assert.equal(readAfterCursor(second.cursor).rewound, true)
  assert.deepEqual(lines(2), [])
  const expected = ['{"a":"☃𝄞"}\r\n', '\n', '{"b":true}']
  writeFileSync(file, expected.join(''))
  for (let n = 1; n <= Buffer.byteLength(expected[0]!); n++) assert.deepEqual(lines(n), expected, `record boundary at piece size ${n}`)
  const scan = transcriptLineBytes(file, { pieceBytes: 2 })
  assert.equal(scan.next().value?.toString(), expected[0])
  appendFileSync(file, '\n{"c":2}\n')
  assert.deepEqual(Array.from(scan, b => b.toString()), expected.slice(1))
  assert.deepEqual(lines(3), [expected[0], expected[1], `${expected[2]}\n`, '{"c":2}\n'])
  writeFileSync(file, '')
  writeFileSync(file, '{"ok":1}\n' + ' '.repeat(300_000) + '\n')
  let count = 0
  setTranscriptReaderIoForTesting({ ...nodeTranscriptReaderIo, readRangeSync(path, start, end) {
    if (++count === 2) unlinkSync(path)
    return nodeTranscriptReaderIo.readRangeSync(path, start, end)
  } })
  const fault = openInitialWorkerTranscript(file, openWorkerTranscript)
  assert(!fault.ok && fault.error.includes('ENOENT'), 'losing the file between pieces must surface the read error')
  setTranscriptReaderIoForTesting(null)
  writeFileSync(file, '{"ok":2}\n')
  const retry = openInitialWorkerTranscript(file, openWorkerTranscript)
  assert(retry.ok && retry.result.records.length === 1, 'the same mirror can read again after the fault')
  let shed = 0
  const messages = ['a','b','c','b','a','d'].map((uuid, i) => ({ uuid, i }))
  assert.deepEqual(mergeFoldedMessages([], messages, 2, () => { shed++ }), [messages[2], messages[5]])
  assert.equal(shed, 2, 'a revision of a shed row does not displace a visible message')
  console.log('History pieces: whole records, all UTF-8 splits, a torn tail, growth, truncation, a mid-read fault and a successful retry')
} finally {
  setTranscriptReaderIoForTesting(null)
  rmSync(home, { recursive: true, force: true })
}
