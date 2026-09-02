#!/usr/bin/env bun
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'keel-epoch-'))
const guard = (p: string): string => {
  const abs = resolve(p)
  if (!abs.startsWith(resolve(SCRATCH))) throw new Error(`refusing write outside scratch: ${abs}`)
  return abs
}
process.env.MERCURY_CONFIG_DIR = guard(join(SCRATCH, 'home'))

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const epoch = await import('../../src/services/run/writerEpoch.ts')

console.log('============================================================')
console.log(' writer epoch: monotonic, clock-proof, stable')
console.log('============================================================')

const claimAsNewProcess = async (): Promise<number> => {
  epoch._resetWriterEpochForTesting()
  return epoch.writerEpoch()
}

const first = await claimAsNewProcess()
const second = await claimAsNewProcess()
const third = await claimAsNewProcess()

check(
  `1. MONOTONIC: three process generations strictly increase (${first} < ${second} < ${third})`,
  first < second && second < third,
  `${first},${second},${third}`,
)

{
  const realNow = Date.now
  Date.now = () => realNow() - 86_400_000
  let underBackwardsClock: number
  try {
    underBackwardsClock = await claimAsNewProcess()
  } finally {
    Date.now = realNow
  }
  check(
    `2. CLOCK-PROOF: a claim under a backwards clock still rises (${third} -> ${underBackwardsClock})`,
    underBackwardsClock > third,
    `got ${underBackwardsClock} after ${third}`,
  )
}

{
  epoch._resetWriterEpochForTesting()
  const [a, b, c] = await Promise.all([epoch.writerEpoch(), epoch.writerEpoch(), epoch.writerEpoch()])
  check(
    '3. STABLE: one process claims ONE epoch however often it asks',
    a === b && b === c,
    `${a},${b},${c}`,
  )
  check('3b. STABLE: the sync accessor agrees with the claim', epoch.currentWriterEpoch() === a)
}

{
  const file = join(process.env.MERCURY_CONFIG_DIR!, 'writer-epoch.json')
  const onDisk = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { epoch?: number }).epoch
    : undefined
  check(
    `4. DURABLE: the counter persisted the claim (${onDisk})`,
    typeof onDisk === 'number' && onDisk >= epoch.currentWriterEpoch(),
    `disk=${onDisk} memory=${epoch.currentWriterEpoch()}`,
  )
}

console.log('════════════════════════════════════════════════════════════')
if (failures > 0) {
  console.error(`❌ ${failures} epoch law(s) failed`)
  process.exit(1)
}
console.log('✅ WRITER EPOCH FENCES')
