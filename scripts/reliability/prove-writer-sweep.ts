#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'keel-writersweep-'))
const guard = (p: string): string => {
  const abs = resolve(p)
  if (!abs.startsWith(resolve(SCRATCH))) throw new Error(`refusing write outside scratch: ${abs}`)
  return abs
}

const overall = setTimeout(() => {
  console.log('\n❌ TIMEOUT — sweep exceeded 480s')
  process.exit(1)
}, 480_000)
overall.unref?.()

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const bunBin = process.execPath.includes('bun')
  ? process.execPath
  : `${process.env.HOME}/.bun/bin/bun`

interface Doc {
  marks?: string[]
}

console.log('============================================================')
console.log(' the literal 5/10/40-writer zero-loss sweep')
console.log('============================================================')

const RUNGS: Array<{ writers: number; perWriter: number }> = [
  { writers: 5, perWriter: 20 },
  { writers: 10, perWriter: 10 },
  { writers: 40, perWriter: 5 },
]

for (const { writers, perWriter } of RUNGS) {
  const file = guard(join(SCRATCH, `sweep-${writers}.json`))
  const barrier = guard(join(SCRATCH, `barrier-${writers}`))
  mkdirSync(barrier)
  console.log(`\n── ${writers} writers × ${perWriter} commits ──`)
  const children = Array.from({ length: writers }, (_, w) =>
    spawn(bunBin, [join(import.meta.dir, '_sweep-writer.ts'), file, `w${w}`, String(perWriter)], {
      env: { ...process.env, KEEL_SWEEP_ROOT: SCRATCH, KEEL_SWEEP_BARRIER: barrier },
      stdio: ['ignore', 'ignore', 'inherit'],
    }),
  )
  while (readdirSync(barrier).filter(f => f.startsWith('ready-')).length < writers) {
    await new Promise(r => setTimeout(r, 20))
  }
  const t0 = Date.now()
  writeFileSync(join(barrier, 'go'), '')
  const codes = await Promise.all(
    children.map(c => new Promise<number>(r => c.once('exit', code => r(code ?? -1)))),
  )
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  check(
    `every writer acked every commit (no retry-budget drop) [${secs}s]`,
    codes.every(c => c === 0),
    `exits: ${codes.join(',')}`,
  )

  const doc = JSON.parse(readFileSync(file, 'utf8')) as Doc
  const marks = doc.marks ?? []
  const expected = writers * perWriter
  check(
    `zero loss: the store holds all ${expected} acked marks`,
    marks.length === expected,
    `held ${marks.length}`,
  )
  check('every mark exactly once (no duplicate applies)', new Set(marks).size === marks.length)
  let ordered = true
  for (let w = 0; w < writers; w++) {
    const mine = marks
      .filter(m => m.startsWith(`w${w}:`))
      .map(m => Number(m.split(':')[1]))
    if (mine.length !== perWriter || mine.some((v, i) => i > 0 && v <= mine[i - 1]!)) {
      ordered = false
      break
    }
  }
  check('per-writer issue order preserved through batching', ordered)
}

rmSync(SCRATCH, { recursive: true, force: true })

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log('✅ WRITER SWEEP: green')
  process.exit(0)
} else {
  console.log(`❌ WRITER SWEEP: ${failures} check(s) failed`)
  process.exit(1)
}
