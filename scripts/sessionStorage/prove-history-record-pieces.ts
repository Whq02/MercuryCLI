#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { appendFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchRoot } from '../engine-durability/harness.ts'

const home = scratchRoot('history-pieces')
const file = join(home, 'history.jsonl')
const { nodeTranscriptReaderIo, setTranscriptReaderIoForTesting, transcriptLineBytes } = await import('../../src/sessions/transcripts/transcriptBytes.ts')
const { openWorkerTranscript, readAfterCursor } = await import('../../src/screen/concourse-model/workerTranscript.ts')
const { openInitialWorkerTranscript, mergeFoldedMessages } = await import('../../src/screen/concourse/workerTranscriptFold.ts')
const lines = (pieceBytes: number) => Array.from(transcriptLineBytes(file, { pieceBytes }), bytes => bytes.toString('utf8'))
try {
  const part = Buffer.from('{"text":"☃"}\n')
  const split = part.indexOf(Buffer.from('☃')) + 1
  writeFileSync(file, part.subarray(0, split))
  const first = openWorkerTranscript(file)
  assert.deepEqual(first.records, [], 'a record cut mid-character must not be returned yet; fix the torn-tail handling in openWorkerTranscript, src/screen/concourse-model/workerTranscript.ts')
  appendFileSync(file, part.subarray(split))
  const second = readAfterCursor(first.cursor)
  assert.deepEqual(second.records, [{ text: '☃' }], 'the cursor must resume at the unfinished UTF-8 character without replacement; fix the cursor offset kept by openWorkerTranscript/readAfterCursor in src/screen/concourse-model/workerTranscript.ts')
  writeFileSync(file, '')
  assert.equal(readAfterCursor(second.cursor).rewound, true, 'a truncated file must report rewound; fix readAfterCursor in src/screen/concourse-model/workerTranscript.ts')
  assert.deepEqual(lines(2), [], 'an empty file must yield no lines; fix transcriptLineBytes in src/sessions/transcripts/transcriptBytes.ts')
  const expected = ['{"a":"☃𝄞"}\r\n', '\n', '{"b":true}']
  writeFileSync(file, expected.join(''))
  for (let n = 1; n <= Buffer.byteLength(expected[0]!); n++) assert.deepEqual(lines(n), expected, `record boundary at piece size ${n}; fix how transcriptLineBytes in src/sessions/transcripts/transcriptBytes.ts joins pieces into whole records`)
  const scan = transcriptLineBytes(file, { pieceBytes: 2 })
  assert.equal(scan.next().value?.toString(), expected[0], 'the first record must come back whole; fix transcriptLineBytes in src/sessions/transcripts/transcriptBytes.ts')
  appendFileSync(file, '\n{"c":2}\n')
  assert.deepEqual(Array.from(scan, b => b.toString()), expected.slice(1), 'a scan already started must see lines appended after it began; fix transcriptLineBytes in src/sessions/transcripts/transcriptBytes.ts')
  assert.deepEqual(lines(3), [expected[0], expected[1], `${expected[2]}\n`, '{"c":2}\n'], 'a fresh scan at piece size 3 must return every record, the unterminated one completed by the appended newline; fix transcriptLineBytes in src/sessions/transcripts/transcriptBytes.ts')
  writeFileSync(file, '')
  writeFileSync(file, '{"ok":1}\n' + ' '.repeat(300_000) + '\n')
  let count = 0
  setTranscriptReaderIoForTesting({ ...nodeTranscriptReaderIo, readRangeSync(path, start, end) {
    if (++count === 2) unlinkSync(path)
    return nodeTranscriptReaderIo.readRangeSync(path, start, end)
  } })
  const fault = openInitialWorkerTranscript(file, openWorkerTranscript)
  assert(!fault.ok && fault.error.includes('ENOENT'), 'losing the file between pieces must surface the read error; fix openInitialWorkerTranscript in src/screen/concourse/workerTranscriptFold.ts')
  setTranscriptReaderIoForTesting(null)
  writeFileSync(file, '{"ok":2}\n')
  const retry = openInitialWorkerTranscript(file, openWorkerTranscript)
  assert(retry.ok && retry.result.records.length === 1, 'the same mirror can read again after the fault; a failed read must leave nothing behind in openWorkerTranscript, src/screen/concourse-model/workerTranscript.ts, that blocks the next open')
  let shed = 0
  const messages = ['a','b','c','b','a','d'].map((uuid, i) => ({ uuid, i }))
  assert.deepEqual(mergeFoldedMessages([], messages, 2, () => { shed++ }), [messages[2], messages[5]], 'mergeFoldedMessages must keep at most cap rows, shedding the oldest uuid first; fix it in src/screen/concourse/workerTranscriptFold.ts')
  assert.equal(shed, 2, 'a revision of a shed row does not displace a visible message; fix the shed callback in mergeFoldedMessages, src/screen/concourse/workerTranscriptFold.ts')
  console.log('History pieces: whole records, all UTF-8 splits, a torn tail, growth, truncation, a mid-read fault and a successful retry')
} finally {
  setTranscriptReaderIoForTesting(null)
  rmSync(home, { recursive: true, force: true })
}
