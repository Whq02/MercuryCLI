#!/usr/bin/env bun
import { waitForConnectorRecords } from '../../src/daemon/switchboard/hopIntoSession.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

function makeFakeConnector(initial: unknown[] = []) {
  let rows = [...initial]
  const listeners = new Set<() => void>()
  let subscribes = 0
  return {
    connector: {
      records: () => rows,
      subscribeRecords: (listener: () => void) => {
        subscribes++
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    emit(next: unknown[]): void {
      rows = next
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
    subscribeCount: () => subscribes,
  }
}

const OLD_POLL_PERIOD_MS = 100

{
  const fake = makeFakeConnector()
  const t0 = performance.now()
  setTimeout(() => fake.emit([{ id: 'r1' }]), 5)
  const settled = await waitForConnectorRecords(fake.connector, 3_000)
  const elapsedMs = Math.round(performance.now() - t0)
  check(
    'waitForConnectorRecords settles when subscribeRecords fires (before the old 100ms poll period)',
    settled === true && elapsedMs < OLD_POLL_PERIOD_MS - 30 && fake.listenerCount() === 0,
    `settled=${settled} elapsedMs=${elapsedMs} listeners=${fake.listenerCount()}`,
  )
}

{
  const fake = makeFakeConnector([{ id: 'r0' }])
  const t0 = performance.now()
  const settled = await waitForConnectorRecords(fake.connector, 3_000)
  const elapsedMs = Math.round(performance.now() - t0)
  check(
    'waitForConnectorRecords returns immediately without subscribing when records are already painted',
    settled === true && elapsedMs < 20 && fake.subscribeCount() === 0 && fake.listenerCount() === 0,
    `settled=${settled} elapsedMs=${elapsedMs} subscribes=${fake.subscribeCount()}`,
  )
}

{
  const fake = makeFakeConnector()
  const t0 = performance.now()
  setTimeout(() => fake.emit([]), 5)
  setTimeout(() => fake.emit([{ id: 'r2' }]), 15)
  const settled = await waitForConnectorRecords(fake.connector, 3_000)
  const elapsedMs = Math.round(performance.now() - t0)
  check(
    'waitForConnectorRecords ignores empty paints and settles on the first non-empty paint before the old 100ms period',
    settled === true && elapsedMs >= 10 && elapsedMs < OLD_POLL_PERIOD_MS - 20 && fake.listenerCount() === 0,
    `settled=${settled} elapsedMs=${elapsedMs} listeners=${fake.listenerCount()}`,
  )
}

{
  const fake = makeFakeConnector()
  const t0 = performance.now()
  const settled = await waitForConnectorRecords(fake.connector, 60)
  const elapsedMs = Math.round(performance.now() - t0)
  check(
    'waitForConnectorRecords settles false at the deadline and unsubscribes its listener',
    settled === false && elapsedMs >= 45 && elapsedMs < 500 && fake.listenerCount() === 0,
    `settled=${settled} elapsedMs=${elapsedMs} listeners=${fake.listenerCount()}`,
  )
}

if (failures > 0) {
  console.log(`\n❌ prove-deadlines-d01 — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\n✅ prove-deadlines-d01 — all checks pass')
