#!/usr/bin/env bun
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

appendFileSync(transcriptPath, 'appended-after-burst\n')
await seam.tick()
const sizeNow = statSync(transcriptPath).size
const lastSize = (conn as unknown as { lastSize: number }).lastSize
check('the pass after an append reads the appended bytes (lastSize = on-disk size)', lastSize === sizeNow, `lastSize=${lastSize} disk=${sizeNow}`)

conn.detach()
check('attach ran its own first read (contract: resolves once the first read completed)', passesAfterAttach >= 1, `attach passes=${passesAfterAttach}`)

console.log(`\n${failures === 0 ? '✅ TRANSCRIPT TICK COALESCE: green' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
