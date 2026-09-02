#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'seat-ceiling-'))
delete process.env.MERCURY_HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

{
  const retiredA = ['CONCOURSE_', 'RUNTIME_CEILING'].join('')
  const retiredB = ['SWITCHBOARD_', 'SEAT_CAP'].join('')
  const hits = execSync(
    `grep -rln "${retiredA}\\|${retiredB}" src --include='*.ts' --include='*.tsx' || true`,
    { cwd: process.cwd(), encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean)
  check('C1 the retired ceiling constants are gone from src', hits.length === 0, hits.join(', '))
}

const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config.ts')
enableConfigs()
const cap = await import('../../src/services/switchboard/capacityCheck.ts')
const sup = await import('../../src/daemon/concourseSupervisor.ts')

{
  const gb = (n: number): number => n * 2 ** 30
  let monotone = true
  let prevRow = -1
  for (let cores = 2; cores <= 32; cores += 2) {
    let prevInRow = -1
    for (let mem = 2; mem <= 64; mem += 2) {
      const seats = cap.machineSeatReading(cores, gb(mem))
      if (seats < prevInRow) monotone = false
      prevInRow = seats
    }
    const colSeats = cap.machineSeatReading(cores, gb(64))
    if (colSeats < prevRow) monotone = false
    prevRow = colSeats
  }
  check('C2 the reading is monotone in cores and in memory', monotone)
  check('C2 the floor is two (one seat would make the switchboard pointless)', cap.machineSeatReading(1, gb(1)) === 2)
  check('C2 a big machine reads PAST five (no upper clamp)', cap.machineSeatReading(32, gb(64)) > 5, String(cap.machineSeatReading(32, gb(64))))
  check('C2 the live reading answers ≥ the floor on THIS machine', cap.machineSeatReading() >= 2, String(cap.machineSeatReading()))
}

{
  const stored = await cap.recordCapacityDecision(false)
  check('C3 declining answers the machine reading (spoken, not stored)', stored.allowed === false && stored.recommendedSeats === cap.machineSeatReading())
  const { getGlobalConfig } = await import('../../src/utils/config.ts')
  const onDisk = getGlobalConfig().switchboardCapacity
  check('C3 the declined decision stores NO number', onDisk !== undefined && onDisk.allowed === false && onDisk.recommendedSeats === undefined, JSON.stringify(onDisk))
  check('C3 the resolved ceiling is the machine reading', cap.resolveSeatCeiling() === cap.machineSeatReading(), String(cap.resolveSeatCeiling()))
  check('C3 the effective ceiling is the same one derivation', sup.effectiveSeatCeiling() === cap.resolveSeatCeiling())
  saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: 0, allowed: false, recommendedSeats: 5 } }))
  check('C3 a declined record that still carries a number reads the machine (no cap survives an upgrade)', cap.resolveSeatCeiling() === cap.machineSeatReading(), String(cap.resolveSeatCeiling()))
  saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: 0, allowed: false, recommendedSeats: 1 } }))
  check('C3 …in either direction (a declined 1 does not shrink the machine reading)', cap.resolveSeatCeiling() === cap.machineSeatReading(), String(cap.resolveSeatCeiling()))
}

{
  for (const seats of [7, 5, 3]) {
    saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: seats } }))
    check(`C4 a stored recommendation of ${seats} is honoured as-is`, cap.resolveSeatCeiling() === seats, String(cap.resolveSeatCeiling()))
  }
  saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: -3 } }))
  check('C4 junk state floors at one', cap.resolveSeatCeiling() === 1, String(cap.resolveSeatCeiling()))
}

{
  const live = Array.from({ length: 4 }, (_, i) => ({ workspaceId: `/scratch/ws-${i}` }))
  const refused = sup.evaluateConcourseAdmission(live, { workspaceId: '/scratch/ws-x' }, 4)
  check(
    "C5 the runtime-ceiling refusal names the machine's reading",
    refused.admit === false && refused.code === 'runtime-ceiling' && (refused.reason ?? '').includes("this machine's reading: 4 seats"),
    JSON.stringify(refused),
  )
  check('C5 describeSeatReading spells the reason beside the number', cap.describeSeatReading(3).includes('3 seats') && cap.describeSeatReading(3).includes('cores/memory'))
}

{
  const gb = (n: number): number => n * 2 ** 30
  const base = cap.recommendSeats({ cores: 16, totalMemBytes: gb(32), freeMemBytes: gb(16), otherAgentClis: 0 })
  const shaved = cap.recommendSeats({ cores: 16, totalMemBytes: gb(32), freeMemBytes: gb(16), otherAgentClis: 3 })
  check('C6 the CLI shave takes one seat, floored at two', base - shaved === 1 && shaved >= 2, `${base} → ${shaved}`)
  check('C6 the consented ladder equals the machine reading before the shave', base === cap.machineSeatReading(16, gb(16)))
}

{
  const strips = readFileSync(join(process.cwd(), 'src/components/concourse/ConcourseStrips.tsx'), 'utf8')
  check('the seats chip reads the effective ceiling', strips.includes('effectiveSeatCeiling()'))
  const route = readFileSync(join(process.cwd(), 'src/components/concourse/ConcourseRoute.tsx'), 'utf8')
  check('the clear-gate reads the effective ceiling', route.includes('snap.counts.live < effectiveSeatCeiling()'))
}

console.log(failures === 0 ? '\nprove-seat-ceiling: ALL LAWS HOLD' : `\nprove-seat-ceiling: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
