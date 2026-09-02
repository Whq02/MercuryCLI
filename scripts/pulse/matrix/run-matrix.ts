#!/usr/bin/env bun

import { distHasSpelling } from '../lib/pulseArena.ts'
import { SCENES, sceneByKey, runScene } from './scenes.ts'

const args = process.argv.slice(2)

if (args.length === 0 || args.includes('--list')) {
  console.log('pulse scene matrix\n')
  const dumpLive = distHasSpelling('MERCURY_PULSE_DUMP')
  const producersLive = distHasSpelling('MERCURY_PULSE_FIXTURE')
  for (const s of SCENES) {
    const req = s.requires
      .map(r =>
        r === 'dump'
          ? `dump:${dumpLive ? 'LIVE' : 'PENDING'}`
          : `producers:${producersLive ? 'LIVE' : 'PENDING'}`,
      )
      .join(' ')
    console.log(`  ${String(s.id).padStart(2)}. ${s.key.padEnd(26)} ${s.status.padEnd(10)} ${req}`)
    if (s.status === 'skip') console.log(`      ↳ ${s.skipReason}`)
  }
  console.log('\nrun: bun run scripts/pulse/matrix/run-matrix.ts <key|id> …')
  process.exit(0)
}

const showEvents = args.includes('--events')
const sceneArgs = args.filter(a => a !== '--events')

for (const key of sceneArgs) {
  const spec = sceneByKey(key)
  console.log(`\n━━ scene ${spec.id} · ${spec.key} — ${spec.title} ━━`)
  if (spec.status === 'skip') {
    console.log(`  SKIPPED (honest): ${spec.skipReason}`)
    continue
  }
  if (spec.status === 'structural') {
    console.log(`  structural — see prove-provider-adapters.ts. ${spec.notes}`)
    continue
  }
  const run = await runScene(spec)
  const reqs = run.fixture.messageRequests()
  console.log(`  fixture /v1/messages requests: ${reqs.length}`)
  console.log(`  tee writes: ${run.teeLines.length} · sends: ${run.sendLog.length}`)
  if (run.pulse.length === 0) {
    console.log(
      distHasSpelling('MERCURY_PULSE_DUMP')
        ? '  dump: ARMED but EMPTY — investigate (seam present in dist, no lines)'
        : '  dump: SEAM-ABSENT (MERCURY_PULSE_DUMP not in dist yet — integrator pending)',
    )
  } else {
    for (const line of run.pulse) {
      const s = line.summary
      console.log(
        `  turn g${s.generation} ${s.status} cold=${s.cold} total=${s.totalMs}ms ack=${s.ackMs}ms ` +
          `localPrep=${s.localPrepMs}ms providerWait=${s.providerWaitMs}ms firstVisible=${s.firstVisibleMs}ms ` +
          `paint=${s.paintMs}ms events=${line.events.length} producers=${line.producers.length}`,
      )
      if (showEvents) {
        for (const e of line.events) console.log(`      ${e.at.toFixed(1).padStart(10)}  ${e.name}`)
        const slow = [...line.producers].sort((a, b) => b.ms - a.ms).slice(0, 6)
        for (const p of slow) console.log(`      producer ${p.label} ${p.ms}ms ${p.outcome} n=${p.count}`)
      }
    }
  }
  if (!process.env.PULSE_ARENA_KEEP) run.cleanup()
}
