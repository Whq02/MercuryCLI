import { BUSY_RETRY_RUNGS_MS, nextBusyRetry, nextBusyRetryWithinBudget, openBusyRetryLadder } from '../../src/services/providers/busyRetry.ts'

const jitter = await import(new URL('../../src/services/api/retryJitter.ts', import.meta.url).href).catch(() => undefined)
let failures = 0
function check(label: string, value: boolean): void {
  console.log(`[${value ? 'PASS' : 'FAIL'}] ${label}`)
  if (!value) failures++
}
const random = Math.random
function walk(seed: number) {
  let state = seed
  Math.random = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0
    return state / 4294967296
  }
  const ladder = openBusyRetryLadder(0, 1)
  const waits: number[] = []
  const times: number[] = []
  let at = 0
  for (let i = 0; i < 7; i++) {
    const step = nextBusyRetry(ladder, undefined, at)
    if (step === null) break
    waits.push(step.waitMs)
    at += step.waitMs
    times.push(at)
    check(`seed ${seed} rung ${i + 1} reports attempt n of 6`, step.attempt === i + 1 && step.of === 6)
  }
  return { ladder, waits, times }
}
try {
  const a = walk(1)
  const b = walk(1215)
  console.log(JSON.stringify({ first: a.times, second: b.times }))
  check('seeded ladders spread every scheduled retry into different seconds', a.times.length === 6 && b.times.length === 6 && a.times.every((at, i) => Math.floor(at / 1000) !== Math.floor(b.times[i]! / 1000)))
  for (const seed of [1, 1215, 0, 42, 10000, 0xffffffff]) {
    const { ladder, waits } = walk(seed)
    check(`seed ${seed} keeps all six steps within 25 percent and the 30 second cap`, waits.length === 6 && waits.every((ms, i) => ms >= BUSY_RETRY_RUNGS_MS[i]! * 0.75 && ms <= Math.min(30000, BUSY_RETRY_RUNGS_MS[i]! * 1.25)))
    check(`seed ${seed} keeps the 61 second total budget and ends`, ladder.spentMs <= 61000 && nextBusyRetry(ladder, undefined, 0) === null)
  }
  for (const draw of [0, 0.5, 1]) {
    Math.random = () => draw
    check(`draw ${draw} keeps the generic path's positive 25 percent spread`, jitter?.jitterRetryDelay(1000) === 1000 + draw * 250)
    check(`draw ${draw} gives the busy path a symmetric 25 percent spread`, jitter?.jitterRetryDelay(1000, 'symmetric') === 750 + draw * 500)
    const ladder = openBusyRetryLadder(0, 1)
    const waits: number[] = []
    for (let i = 0; i < 7; i++) {
      const step = nextBusyRetry(ladder, undefined, 0)
      if (step === null) break
      waits.push(step.waitMs)
    }
    check(`draw ${draw} preserves six bounded rungs even at the spread extremes`, waits.length === 6 && ladder.spentMs <= 61000 && waits.every((ms, i) => ms >= BUSY_RETRY_RUNGS_MS[i]! * 0.75 && ms <= Math.min(30000, BUSY_RETRY_RUNGS_MS[i]! * 1.25)))
  }
  const asked = openBusyRetryLadder(0, 1)
  const step = nextBusyRetry(asked, 5000, 0)
  check('a provider wait is a minimum, not jittered shorter', step?.waitMs === 5000)
  const bounded = openBusyRetryLadder(0, 1, 1200)
  check('a provider wait beyond the remaining budget is refused', nextBusyRetryWithinBudget(bounded, 1500, 0) === null)
} finally {
  Math.random = random
}
console.log(`${failures ? 'FAIL' : 'PASS'} busy retry jitter: ${failures} failures`)
process.exitCode = failures ? 1 : 0
