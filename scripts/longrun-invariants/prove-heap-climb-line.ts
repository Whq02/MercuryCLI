#!/usr/bin/env bun
import '../lib/hermetic.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { heapClimbLine } = await import('../../src/boot/main/heapClimb.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const MB = 1024 * 1024
const LIMIT = 4288 * MB

console.log('the used heap is named in the debug log each time it passes another 500 MB')

let passed = 0
const lines: string[] = []
for (const usedMb of [120, 388, 499, 500, 730, 999, 1000, 1475, 1474, 1502, 2598, 2100, 3435, 3679, 3723, 4100]) {
  const climb = heapClimbLine(usedMb * MB, LIMIT, passed)
  if (climb === null) continue
  passed = climb.steps
  lines.push(climb.line)
}

check('a heap under 500 MB writes nothing', heapClimbLine(499 * MB, LIMIT, 0) === null, 'heapClimbLine in src/boot/main/heapClimb.ts must return null below the first 500 MB step')
check(
  'a session that climbs the way the session of 20 Nov did writes one line a step: 500, 1,000, 1,500, 2,500, 3,000, 3,500, 4,000 MB',
  JSON.stringify(lines.map(line => line.match(/passed (\d+) MB/)?.[1])) === JSON.stringify(['500', '1000', '1500', '2500', '3000', '3500', '4000']),
  `${JSON.stringify(lines)}; heapClimbLine in src/boot/main/heapClimb.ts must return one line per newly passed 500 MB step`,
)
check(
  'the line names the used size and the limit',
  lines[0] === '[heap] used heap passed 500 MB: 500 MB used of a 4288 MB limit' && lines.at(-1) === '[heap] used heap passed 4000 MB: 4100 MB used of a 4288 MB limit',
  `${lines[0]} … ${lines.at(-1)}; the line text is built by heapClimbLine in src/boot/main/heapClimb.ts`,
)
check('a heap that falls back and returns to a step it has passed writes nothing again', heapClimbLine(1474 * MB, LIMIT, 2) === null && heapClimbLine(1200 * MB, LIMIT, 3) === null, 'heapClimbLine in src/boot/main/heapClimb.ts must return null when the step was already passed')

console.log(failures === 0 ? '\n ✅ THE HEAP CLIMB IS NAMED' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
