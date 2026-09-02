// probe-scribe-roundtrip — the reactive-substrate program's HEADLINE METRIC.
//
// Measures the TRANSPORT latency of one Scribe→Implementer→Scribe round trip with
// ZERO model time (a fake Implementer echoes instantly), isolating what the bus
// itself costs. Three legs, exactly the production path:
//
//   leg A  Scribe dispatch    writeToMailbox(implementer inbox)          t0
//   leg B  daemon drain       armDispatchDrain (inbox SUBSCRIPTION)      t1
//   echo   fake Implementer   buildProgress → writeToMailbox(team-lead)  (0ms)
//   leg C  foreground         team-lead inbox SUBSCRIPTION               t2
//
// Uses the REAL production engines end to end: the daemon's subscription-driven
// drain (armDispatchDrain) and the foreground's inbox subscription (what
// useInboxPoller rides). BEFORE Phase 2 (two stacked 1s polls) this measured
// median 1790ms; the Phase 2 target is <200ms. The journal+subscribe path is
// measured here — the authed-socket fast path (envelope op) is faster still but
// needs a live daemon.
//
// Standalone measurement (bun run scripts/substrate/probe-scribe-roundtrip.ts).
// NOT part of run-all.sh — it is a stopwatch, not a proof.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'hermes-probe-'))
process.env.MERCURY_CONFIG_DIR = tmp

const { buildDispatch, buildProgress, parseScribeEnvelope } = await import(
  '../../src/utils/scribe/scribeBus.ts'
)
const { writeToMailbox, getMailboxStore, markMessagesAsReadByPredicate } =
  await import('../../src/utils/teammateMailbox.ts')
const { armDispatchDrain } = await import(
  '../../src/daemon/scribeDispatchBridge.ts'
)

const ITERATIONS = 7
const TEAM = 'scribe'

type Sample = { dispatchToStdin: number; replyToSeen: number; total: number }

// In-flight bookkeeping: request_id → timestamps.
const t0 = new Map<string, number>()
const t1 = new Map<string, number>()
const settled = new Map<string, (s: Sample) => void>()

// The fake roster: reply == "delivered to Implementer stdin". Echo instantly with
// a progress envelope to the team-lead inbox (what the Implementer's SendMessage does).
const fakeRoster = {
  reply: async (_short: string, frameText: string): Promise<boolean> => {
    const frame = JSON.parse(frameText) as { message: { content: string } }
    // The frame body is framing + the dispatch task text; recover the id by matching
    // any in-flight request_id embedded during dispatch (task carries the id).
    const m = frame.message.content.match(/probe-task ([a-z0-9-]+)/)
    if (!m) return true
    const id = m[1]!
    t1.set(id, performance.now())
    const echo = buildProgress('implementer', 'done', { refRequestId: id })
    await writeToMailbox(
      'team-lead',
      { from: 'implementer', text: JSON.stringify(echo), timestamp: new Date().toISOString() },
      TEAM,
    )
    return true
  },
}

// Daemon leg — the PRODUCTION engine (reactive-substrate Phase 2): the
// subscription-driven drain, exactly what daemon/main.ts arms.
const daemonDrain = armDispatchDrain(fakeRoster, {
  short: 'implementer',
  agentName: 'implementer',
  teamName: TEAM,
})

// Foreground leg — the PRODUCTION engine: the team-lead inbox subscription
// (what useInboxPoller now rides), same consume-then-mark semantics.
const unsubForeground = getMailboxStore('team-lead', TEAM).subscribe(
  messages => {
    void (async () => {
      for (const msg of messages) {
        if (msg.read) continue
        const env = parseScribeEnvelope(msg.text)
        if (env?.kind === 'progress' && env.refRequestId && settled.has(env.refRequestId)) {
          const id = env.refRequestId
          const now = performance.now()
          const start = t0.get(id)!
          const stdinAt = t1.get(id) ?? now
          await markMessagesAsReadByPredicate(
            'team-lead',
            x => parseScribeEnvelope(x.text)?.refRequestId === id,
            TEAM,
          )
          settled.get(id)!({
            dispatchToStdin: stdinAt - start,
            replyToSeen: now - stdinAt,
            total: now - start,
          })
          settled.delete(id)
        }
      }
    })().catch(() => {})
  },
  { immediate: false },
)

async function oneRoundTrip(i: number): Promise<Sample> {
  const env = buildDispatch('team-lead', `probe-task ${crypto.randomUUID()} (#${i})`)
  const id = env.task.match(/probe-task ([a-z0-9-]+)/)![1]!
  const done = new Promise<Sample>(resolve => settled.set(id, resolve))
  t0.set(id, performance.now())
  await writeToMailbox(
    'implementer',
    { from: 'team-lead', text: JSON.stringify(env), timestamp: new Date().toISOString() },
    TEAM,
  )
  return done
}

const samples: Sample[] = []
for (let i = 0; i < ITERATIONS; i++) {
  samples.push(await oneRoundTrip(i))
  // Random settle so successive dispatches land at fresh poll phases.
  await new Promise(r => setTimeout(r, 150 + Math.random() * 700))
}

daemonDrain.dispose()
unsubForeground()
rmSync(tmp, { recursive: true, force: true })

const totals = samples.map(s => s.total).sort((a, b) => a - b)
const median = totals[Math.floor(totals.length / 2)]!
const r = (n: number) => Math.round(n)
for (const [i, s] of samples.entries())
  console.log(
    `  #${i}: dispatch→stdin ${r(s.dispatchToStdin)}ms · reply→seen ${r(s.replyToSeen)}ms · total ${r(s.total)}ms`,
  )
console.log(
  `PROBE_RESULT_JSON ${JSON.stringify({ medianMs: r(median), minMs: r(totals[0]!), maxMs: r(totals[totals.length - 1]!), iterations: ITERATIONS })}`,
)
