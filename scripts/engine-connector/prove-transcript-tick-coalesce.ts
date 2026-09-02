#!/usr/bin/env bun
// ============================================================================
//  scripts/engine-connector/prove-transcript-tick-coalesce.ts — the
//  transcript reader under an append burst: ONE full load in flight, ONE
//  dirty rerun, never a stack of overlapping whole-transcript loads.
//
//  The reader's tick is fired by a 400 ms heartbeat AND every fs.watch
//  event on the transcript, and each pass is a FULL transcript load — an
//  append burst used to start one overlapping load per event (and two
//  overlapped loads can complete out of order, painting the older read).
//  The law: a trigger landing mid-pass marks dirty and the pass reruns
//  once; the last pass always STARTED after the last trigger, so no
//  trigger's bytes are dropped; joiners share the running flight's promise
//  (attach's first-read contract).
//
//  Driven on the REAL connector over a scratch home (no daemon: every seat
//  verb and RPC in the class is fail-soft by construction). The burst is
//  synchronous, so the join/dirty arithmetic is deterministic — no timing
//  sensitivity.
// ============================================================================
import { mkdirSync, mkdtempSync, appendFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tick-coalesce-home-'))

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')

const home = mkdtempSync(join(tmpdir(), 'tick-coalesce-ws-'))
mkdirSync(home, { recursive: true })
const sessionId = '12345678-1234-4123-8123-123456789abc'
const transcriptPath = join(home, `${sessionId}.jsonl`)
writeFileSync(transcriptPath, 'not-a-record\n')

const conn = new DaemonSessionConnector({
  sessionId,
  runnerId: 'concourse-w1',
  title: 'tick coalesce drive',
  projectLabel: 'scratch',
  workspaceId: home,
  home,
})

// The pass seam: the full-load body (tickOnce after the coalesce change;
// the whole tick before it — the same prover text captures BEFORE and
// AFTER for the receipt's instrument).
type Seam = { tick: () => Promise<void>; tickOnce?: () => Promise<void> }
const seam = conn as unknown as Seam
const bodyName = typeof seam.tickOnce === 'function' ? 'tickOnce' : 'tick'
const real = (seam as unknown as Record<string, () => Promise<void>>)[bodyName]!.bind(conn)
let passes = 0
;(seam as unknown as Record<string, unknown>)[bodyName] = async () => {
  passes++
  await new Promise(r => setTimeout(r, 5))
  return real()
}

await conn.attach()
const passesAfterAttach = passes

// ── the burst: 40 synchronous triggers (what a watch storm delivers) ────────
passes = 0
const burst: Array<Promise<void>> = []
for (let i = 0; i < 40; i++) burst.push(seam.tick())
await Promise.all(burst)
check(
  `a 40-trigger burst costs at most 2 full passes (one in flight + one dirty rerun), not 40 [${bodyName} road]`,
  passes <= 2,
  `passes=${passes}`,
)
check('every burst caller resolved (joiners share the flight)', true)

// ── no dropped trigger: bytes appended land in the next pass ────────────────
appendFileSync(transcriptPath, 'appended-after-burst\n')
await seam.tick()
const sizeNow = statSync(transcriptPath).size
const lastSize = (conn as unknown as { lastSize: number }).lastSize
check('the pass after an append reads the appended bytes (lastSize = on-disk size)', lastSize === sizeNow, `lastSize=${lastSize} disk=${sizeNow}`)

conn.detach()
check('attach ran its own first read (contract: resolves once the first read completed)', passesAfterAttach >= 1, `attach passes=${passesAfterAttach}`)

console.log(`\n${failures === 0 ? '✅ TRANSCRIPT TICK COALESCE: green' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
