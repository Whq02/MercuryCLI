#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const CEILINGS = join(ROOT, 'scripts/gate/suite-ceilings.tsv')
const DEFAULT_CEILING = 900
const STRETCH = 3
const STEP = 300

type Measured = { host: string; wall: number; scale: number }
type Hosted = { done: string; authoredDone: number; wall: number } | { killedAt: number }
type Suite = { suite: string; authored: number; measured: Measured[]; hosted: Hosted }

const SUITES: Suite[] = [
  {
    suite: 'api-drives',
    authored: 488,
    measured: [
      { host: 'Mac 2026-10-13 16:31 through scripts/gate/run-suite.sh', wall: 663, scale: 1.4 },
      { host: 'Linux container, the .35 drives night', wall: 662, scale: 1.4 },
      { host: 'Mac, the .34 linux-drives-read report', wall: 488, scale: 1.0 },
    ],
    hosted: { done: '3 of 5 members', authoredDone: 379, wall: 755 },
  },
  {
    suite: 'switchboard-drives',
    authored: 1039,
    measured: [{ host: 'Mac 2026-10-13 16:42 through scripts/gate/run-suite.sh', wall: 1351, scale: 1.3 }],
    hosted: { killedAt: 1200 },
  },
  {
    suite: 'ui-drives',
    authored: 3896,
    measured: [{ host: 'Linux container, the .35 drives night', wall: 5455, scale: 1.4 }],
    hosted: { done: '25 of 34 members', authoredDone: 2381, wall: 5470 },
  },
]

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

function rowOf(suite: string): number | undefined {
  for (const line of readFileSync(CEILINGS, 'utf8').split('\n')) {
    const [name, seconds] = line.split('\t')
    if (name === suite && seconds !== undefined && /^[0-9]+$/.test(seconds) && Number(seconds) > 0) return Number(seconds)
  }
  return undefined
}

console.log('the three drive ceilings read from measured walls (scripts/gate/suite-ceilings.tsv)')
for (const { suite, authored, measured, hosted } of SUITES) {
  const row = rowOf(suite)
  const ceiling = row ?? DEFAULT_CEILING
  const envelope = Math.ceil((authored * STRETCH) / STEP) * STEP
  console.log(`\n${suite}: row ${row ?? '(none, the default 900 s)'} · authored ${authored} s · ${STRETCH}× stretch ${envelope} s`)
  check(`${suite} carries a row of its own, not the default ceiling`, row !== undefined)
  for (const { host, wall, scale } of measured) {
    const seen = wall / scale
    check(`${suite}: the ${host} wall (${wall} s at scale ${scale}) reads the authored wall within 5% (${seen.toFixed(0)} s against ${authored} s)`, Math.abs(seen - authored) <= authored * 0.05)
    check(`${suite}: the ceiling stands above that measured wall`, ceiling > wall, `${ceiling} <= ${wall}`)
  }
  if ('killedAt' in hosted) {
    check(`${suite}: the ceiling stands above the ${hosted.killedAt} s the hosted runner tree-killed it at`, ceiling > hosted.killedAt, `${ceiling} <= ${hosted.killedAt}`)
  } else {
    const pace = hosted.wall / hosted.authoredDone
    const projection = Math.ceil(pace * authored)
    check(`${suite}: the ceiling stands above the hosted pace (${pace.toFixed(2)}× authored on ${hosted.done}) projected over the whole suite (${projection} s)`, ceiling > projection, `${ceiling} <= ${projection}`)
  }
  check(`${suite}: the ceiling is the ${STRETCH}× stretch over the authored wall rounded up to ${STEP} s (${envelope} s)`, ceiling === envelope, `${ceiling} !== ${envelope}`)
}

console.log(`\n${failures === 0 ? 'OK' : 'FAIL'} — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
