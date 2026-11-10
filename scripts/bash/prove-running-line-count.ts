#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { TaskOutput } = await import('../../src/utils/task/TaskOutput.ts')
const { generateTaskId } = await import('../../src/Task.ts')

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}

type Seen = { recent: string; lines: number; bytes: number; partial: boolean }
const made: Array<InstanceType<typeof TaskOutput>> = []

function piped(): { write: (chunk: string) => void; counts: number[]; now: () => number } {
  const counts: number[] = []
  let last: Seen | null = null
  const output = new TaskOutput(generateTaskId('local_bash'), (recent, _full, lines, bytes, partial) => { last = { recent, lines, bytes, partial }; counts.push(lines) }, false)
  made.push(output)
  return {
    write: chunk => output.writeStdout(chunk),
    counts,
    now: () => {
      output.emitLiveView()
      return (last as Seen | null)?.lines ?? -1
    },
  }
}

function filed(): { put: (content: string) => void; add: (content: string) => void; read: () => Promise<Seen> } {
  let last: Seen | null = null
  const output = new TaskOutput(generateTaskId('local_bash'), (recent, _full, lines, bytes, partial) => { last = { recent, lines, bytes, partial } }, true)
  made.push(output)
  mkdirSync(dirname(output.path), { recursive: true })
  return {
    put: content => writeFileSync(output.path, content),
    add: content => appendFileSync(output.path, content),
    read: async () => {
      await output.sampleFileProgress()
      return last ?? { recent: '', lines: -1, bytes: -1, partial: false }
    },
  }
}

section('a command whose output is read from its file: the count is the lines printed')
{
  const two = filed()
  two.put('a\nb\n')
  const whole = await two.read()
  check('two lines, each ended: 2', whole.lines === 2, whole)
  check('the view under the row is the same text as before', whole.recent === 'a\nb\n', whole.recent)
  const open = filed()
  open.put('a\nb')
  check('two lines, the last not ended yet: 2', (await open.read()).lines === 2, await open.read())
  const none = filed()
  none.put('')
  check('nothing printed: 0', (await none.read()).lines === 0, await none.read())
  const one = filed()
  one.put('only\n')
  check('one line: 1', (await one.read()).lines === 1, await one.read())
  const twelve = filed()
  twelve.put(Array.from({ length: 12 }, (_, index) => `L1x line ${index + 1} of 12\n`).join(''))
  check('twelve lines: 12', (await twelve.read()).lines === 12, await twelve.read())
  const inside = filed()
  inside.put('a\nb')
  const first = (await inside.read()).lines
  inside.add('c\n')
  const second = (await inside.read()).lines
  check('the file grows inside a line: 2, then 2', first === 2 && second === 2, { first, second })
  const onNewline = filed()
  onNewline.put('a\n')
  const before = (await onNewline.read()).lines
  onNewline.add('b\n')
  const after = (await onNewline.read()).lines
  check('the file grows exactly on a newline: 1, then 2', before === 1 && after === 2, { before, after })
  const blankFirst: Array<[string, number]> = [['\n', 1], ['\n\n', 2], ['\na\n', 2], ['\n\na\nb\n', 4], ['\na', 2], ['a\n\nb\n', 3]]
  const wrongFiled: string[] = []
  for (const [content, want] of blankFirst) {
    const one = filed()
    one.put(content)
    const got = (await one.read()).lines
    if (got !== want) wrongFiled.push(`${JSON.stringify(content)} read ${got}, printed ${want}`)
  }
  check('output that begins with a blank line, or holds one: each blank line is a line', wrongFiled.length === 0, wrongFiled.join(' · '))
  const long = filed()
  long.put('xxxxxxxxx\n'.repeat(1000))
  const sampled = await long.read()
  check('a file larger than one sample: the count is an estimate of its 1,000 lines, and says so', sampled.partial && Math.abs(sampled.lines - 1000) <= 1, sampled)
}

section('a command whose output arrives in chunks: the same count')
{
  const two = piped()
  two.write('a\nb\n')
  check('two lines, each ended: 2', two.now() === 2 && two.counts.at(-2) === 2, two.counts)
  const open = piped()
  open.write('a\nb')
  check('two lines, the last not ended yet: 2', open.now() === 2, open.counts)
  const none = piped()
  check('nothing printed: 0', none.now() === 0, none.counts)
  const lone = piped()
  lone.write('no newline yet')
  check('one line still being printed: 1', lone.now() === 1, lone.counts)
  const inside = piped()
  inside.write('a\nb')
  const first = inside.now()
  inside.write('c\n')
  const second = inside.now()
  check('a chunk boundary inside a line: 2, then 2', first === 2 && second === 2, { first, second })
  const onNewline = piped()
  onNewline.write('a\n')
  const before = onNewline.now()
  onNewline.write('b\n')
  const after = onNewline.now()
  check('a chunk boundary exactly on a newline: 1, then 2', before === 1 && after === 2, { before, after })
  const wrongPiped: string[] = []
  for (const [content, want] of [['\n', 1], ['\n\n', 2], ['\na\n', 2], ['\n\na\nb\n', 4], ['\na', 2], ['a\n\nb\n', 3]] as Array<[string, number]>) {
    const one = piped()
    one.write(content)
    const got = one.now()
    if (got !== want) wrongPiped.push(`${JSON.stringify(content)} read ${got}, printed ${want}`)
  }
  check('output that begins with a blank line, or holds one: the same counts as from the file', wrongPiped.length === 0, wrongPiped.join(' · '))
  const twelve = piped()
  for (let index = 1; index <= 12; index++) twelve.write(`L1x line ${index} of 12\n`)
  check('twelve lines, one chunk each: 12 on the last report', twelve.counts.at(-1) === 12 && twelve.now() === 12, twelve.counts)
}

for (const output of made) {
  await output.flush()
  output.clear()
  await output.deleteOutputFile()
}
console.log(`\n${checks - failures} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
