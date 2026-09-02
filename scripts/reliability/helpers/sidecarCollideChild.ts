import { readdirSync } from 'node:fs'
import { dirname, basename } from 'node:path'
import { makeOwnerKey } from '../../../src/services/run/ownerKey.ts'
import { emptyRunSnapshot } from '../../../src/services/run/runKernel.ts'
import {
  loadRunSidecar,
  runSidecarPath,
  saveRunSidecar,
} from '../../../src/services/run/runSidecar.ts'

const owner = makeOwnerKey({
  workspace: process.cwd(),
  sessionId: 'relia-fc2-session',
  lane: 'main',
})
const at = Date.now()
const snapA = emptyRunSnapshot({
  runId: 'run-a',
  owner,
  objective: 'A'.repeat(64 * 1024),
  rootMessageId: null,
  at,
})
const snapB = emptyRunSnapshot({
  runId: 'run-b',
  owner,
  objective: 'B'.repeat(8 * 1024),
  rootMessageId: null,
  at,
})

const ROUNDS = 50
let anomalies = 0
for (let i = 0; i < ROUNDS; i++) {
  const settled = await Promise.allSettled([
    saveRunSidecar(owner, snapA),
    saveRunSidecar(owner, snapB),
  ])
  if (settled.some(s => s.status === 'rejected')) {
    anomalies++
    continue
  }
  const load = await loadRunSidecar(owner)
  if (load.state !== 'loaded') anomalies++
  else if (load.snapshot.runId !== 'run-a' && load.snapshot.runId !== 'run-b') anomalies++
}
const file = runSidecarPath(owner)
const orphanTmps = readdirSync(dirname(file)).filter(
  f => f.startsWith(basename(file)) && f.includes('.tmp'),
).length
console.log(JSON.stringify({ rounds: ROUNDS, anomalies, orphanTmps }))
process.exit(0)
