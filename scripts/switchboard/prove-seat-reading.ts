#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'seat-reading-'))
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SEATS

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const cap = await import('../../src/services/switchboard/capacityCheck.ts')

const GB = 2 ** 30
const MB = 2 ** 20
const gb = (n: number): number => n * GB
const COST = cap.SEAT_COST_BYTES[cap.SEAT_COST_KIND]

{
  const vmStat = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                                5294.',
    'Pages active:                            105294.',
    'Pages inactive:                           99525.',
    'Pages speculative:                         1140.',
    'Pages throttled:                              0.',
    'Pages wired down:                        114356.',
    'Pages purgeable:                           2742.',
    '"Translation faults":                4887273106.',
    'Pages copy-on-write:                  227367349.',
    'File-backed pages:                        66855.',
    'Anonymous pages:                         139104.',
    'Pages stored in compressor:              946903.',
    '',
  ].join('\n')
  const vmAvailable = cap.availableFromVmStat(vmStat)
  const want = (5294 + 99525 + 1140 + 2742) * 16384
  check('R1 vm_stat: free + inactive + speculative + purgeable pages × the page size', vmAvailable === want, `${vmAvailable} vs ${want}`)
  check('R1 vm_stat: the honest figure is many times the free figure', vmAvailable !== null && vmAvailable > 5294 * 16384 * 15, String(vmAvailable))
  check('R1 vm_stat: junk text answers null', cap.availableFromVmStat('not a vm_stat page') === null && cap.availableFromVmStat('') === null)
  check('R1 vm_stat: a page without the free/inactive rows answers null', cap.availableFromVmStat('Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages active: 5.\n') === null)

  const meminfo = [
    'MemTotal:       16303372 kB',
    'MemFree:          812340 kB',
    'MemAvailable:   11022196 kB',
    'Buffers:          240120 kB',
    'Cached:          9012000 kB',
    '',
  ].join('\n')
  check('R1 meminfo: MemAvailable in kB, never MemFree', cap.availableFromMeminfo(meminfo) === 11022196 * 1024, String(cap.availableFromMeminfo(meminfo)))
  check('R1 meminfo: text without MemAvailable answers null', cap.availableFromMeminfo('MemTotal: 1 kB\nMemFree: 1 kB\n') === null)
  check('R1 the counter: the available-bytes figure passes through; junk answers null', cap.availableFromCounter(gb(5)) === gb(5) && cap.availableFromCounter(Number.NaN) === null && cap.availableFromCounter(-1) === null)
}

{
  check(`R2 a seat is costed at the runner's price (${Math.round(COST / MB)} MB)`, cap.SEAT_COST_KIND === 'runner' && COST === cap.SEAT_COST_BYTES.runner && cap.SEAT_COST_BYTES.agent < cap.SEAT_COST_BYTES.runner)
  const eightCoreFourGb = cap.machineSeatReading(8, gb(4))
  check('R2 an 8-core Mac with four gigabytes to give reads ten, not two', eightCoreFourGb === Math.min(16, Math.floor(gb(4) / COST)) && eightCoreFourGb >= 8, String(eightCoreFourGb))
  check('R2 the cores term is two seats a core (never cores/2)', cap.machineSeatReading(4, gb(64)) === 8 && cap.machineSeatReading(1, gb(64)) === 2, `${cap.machineSeatReading(4, gb(64))} · ${cap.machineSeatReading(1, gb(64))}`)
  check('R2 the memory term is available memory over the cost', cap.machineSeatReading(32, COST * 5) === 5 && cap.machineSeatReading(32, COST * 5 - 1) === 4, `${cap.machineSeatReading(32, COST * 5)} · ${cap.machineSeatReading(32, COST * 5 - 1)}`)
  check('R2 the floor is two', cap.machineSeatReading(1, 0) === 2 && cap.machineSeatReading(0, gb(64)) === 2)
  let monotone = true
  let prevCol = -1
  for (let cores = 1; cores <= 32; cores += 1) {
    let prev = -1
    for (let mem = 0; mem <= 64; mem += 1) {
      const seats = cap.machineSeatReading(cores, gb(mem))
      if (seats < prev) monotone = false
      prev = seats
    }
    const col = cap.machineSeatReading(cores, gb(64))
    if (col < prevCol) monotone = false
    prevCol = col
  }
  check('R2 the ladder is monotone in cores and in memory', monotone)
  check('R2 no upper clamp: a big box reads past sixteen', cap.machineSeatReading(32, gb(64)) > 16, String(cap.machineSeatReading(32, gb(64))))
  check('R2 the in-process agent kind costs less and reads more on the same box', cap.machineSeatReading(32, gb(8), 'agent') > cap.machineSeatReading(32, gb(8), 'runner'))
}

{
  let answer = COST * 3
  let taken = 0
  cap._setMemorySamplerForTesting(() => {
    taken++
    return { cores: 8, availableBytes: answer, read: 'vm_stat' }
  })
  const first = cap.heldMachineSeatReading()
  check('R3 the first ask reads three seats from three costs of memory', first === 3, String(first))
  const facts1 = cap.heldMachineSeatFacts()
  check('R3 the held facts carry the sample the reading stands on', facts1.sample !== null && facts1.sample.availableBytes === COST * 3 && facts1.sample.read === 'vm_stat', JSON.stringify(facts1))
  const inside = cap.heldMachineSeatReading()
  check('R3 an ask inside the sample window re-reads the held mark (no new sample)', inside === 3 && taken === 1, `${inside} · samples taken ${taken}`)
  answer = COST * 6
  await wait(5_100)
  const rise = cap.heldMachineSeatReading()
  check('R3 a fresh ask under MORE available memory raises the reading (six)', rise === 6 && taken === 2, `${rise} · samples taken ${taken}`)
  answer = COST * 1
  await wait(5_100)
  const held = cap.heldMachineSeatReading()
  const facts = cap.heldMachineSeatFacts()
  check('R3 a fresh ask under LESS available memory never lowers the reading — six stands', held === 6 && taken === 3, `${held} · samples taken ${taken}`)
  check('R3 the held facts keep the inputs of the reading that stands (six costs), not the lower sample', facts.sample !== null && facts.sample.availableBytes === COST * 6, JSON.stringify(facts.sample))
  answer = COST * 9
  await wait(5_100)
  const raised = cap.heldMachineSeatReading()
  check('R3 a later ask under MORE memory raises it again (nine)', raised === 9, String(raised))
  cap._setMemorySamplerForTesting(null)
}

{
  const words = cap.seatReadingInputsWords({ cores: 8, availableBytes: 3.1 * GB, read: 'vm_stat', sampledAt: 0 })
  check('R4 the inputs sentence: cores, GB available, the cost a seat', words === `8 cores, 3.1 GB available, ${Math.round(COST / MB)} MB a seat`, words)
  const whole = cap.seatReadingInputsWords({ cores: 16, availableBytes: 24.6 * GB, read: 'meminfo', sampledAt: 0 })
  check('R4 ten or more GB print whole', whole.startsWith('16 cores, 25 GB available'), whole)
  cap._setHeldMachineSeatReadingForTesting(null)
  const live = cap.sampleAvailableMemory()
  const source = process.platform === 'darwin' ? 'vm_stat' : process.platform === 'linux' ? 'meminfo' : 'counter'
  check(`R4 the live sampler on this machine answers from its named source (${source})`, live.read === source && live.availableBytes > 0 && live.totalBytes >= live.availableBytes, JSON.stringify(live))
  const facts = cap.heldMachineSeatFacts()
  check('R4 the live held facts carry a real sample and the sentence names it', facts.sample !== null && facts.sample.cores >= 1 && cap.describeSeatReading(facts.seats).includes(`(${cap.seatReadingInputsWords(facts.sample)})`), cap.describeSeatReading(facts.seats))
  cap._setHeldMachineSeatReadingForTesting(5)
  check('R4 a fixture reading without a sample speaks the number alone', cap.describeSeatReading(5) === "this machine's reading: 5 seats", cap.describeSeatReading(5))
  cap._setHeldMachineSeatReadingForTesting(null)
}

{
  const base = cap.recommendSeats({ cores: 8, totalMemBytes: gb(8), availableMemBytes: COST * 10, otherAgentClis: 0 })
  const shaved = cap.recommendSeats({ cores: 8, totalMemBytes: gb(8), availableMemBytes: COST * 10, otherAgentClis: 3 })
  check('R5 the consented ladder equals the machine reading over the available figure', base === cap.machineSeatReading(8, COST * 10) && base === 10, String(base))
  check('R5 the CLI shave takes one seat', base - shaved === 1, `${base} → ${shaved}`)
  const probe = await cap.probeCapacity()
  check('R5 the live probe carries the available figure (never a bare free)', probe.availableMemBytes > 0 && probe.availableMemBytes <= probe.totalMemBytes && Number.isInteger(probe.otherAgentClis), JSON.stringify({ ...probe }))
}

console.log(failures === 0 ? '\nprove-seat-reading: ALL LAWS HOLD' : `\nprove-seat-reading: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
