#!/usr/bin/env bun
(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }


let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('§1 CB-04 — the zero-row drop-down arm refused at the door; shrink disarms')
{
  const { switchboardGeometry, resolveConcourseProfile } = await import(
    '../../src/screen/concourse/ConcourseLayout.tsx'
  )
  const grant0 = switchboardGeometry(80, 22, 3, 6, 2, 0, 8).peekRows
  check('the hazard exists: the stacked minimum with a full ask block grants the 8-row ask 0 rows', grant0 === 0, `granted ${grant0}; check switchboardGeometry in src/screen/concourse/ConcourseLayout.tsx (peekRows for the stacked minimum)`)
  check('the 2-row floor is the ask floor (max(2, …)) — one number, two sites', resolveConcourseProfile(120, 24) === 'wide', 'resolveConcourseProfile in src/screen/concourse/ConcourseLayout.tsx must return wide at 120 columns')
}


console.log("§5 A7 — the exit-grammar pair (c/d) is never eaten by a letter-verb")
{
  const { interpretKey } = await import('../../src/screen/renderer/input/interpreter.ts')
  const k = interpretKey('\x03') as { name?: string; ctrl?: boolean }
  check(
    "the decoder fact that makes the guard load-bearing: \\x03 → {name:'c', ctrl:true}",
    k.name === 'c' && k.ctrl === true,
    `got ${JSON.stringify(k)}; check interpretKey in src/screen/renderer/input/interpreter.ts for the 0x03 byte`,
  )
}

console.log(failures === 0 ? '\nnever-stranded-input: GREEN' : `\nnever-stranded-input: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
