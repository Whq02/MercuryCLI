#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = join(import.meta.dir, '..', '..')
delete process.env.MERCURY_BOX_LOCK_DIR

const box = await import('../../src/utils/boxLock.ts')
const seatWire = await import('../../src/services/engine-connector/seatWire.ts')
const { resolveResource } = await import('../../src/services/resources/registry.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const j = (v: unknown): string => JSON.stringify(v)

const scratch = mkdtempSync(join(tmpdir(), 'box-facts-'))
const lockDir = join(scratch, 'coordination')
mkdirSync(join(lockDir, 'box.queue'), { recursive: true })
mkdirSync(join(lockDir, 'box.lock'))
mkdirSync(join(lockDir, 'box.lock.3'))
writeFileSync(join(lockDir, 'box.lock', 'holder'), `${process.pid} harness-build 08:00:00\n`)
writeFileSync(join(lockDir, 'box.lock.3', 'holder'), '2147483000 gone-lane 07:59:00\n')
const now = Date.now()
writeFileSync(join(lockDir, 'box.queue', '1000-lane-a.ticket'), 'lane-a\n')
utimesSync(join(lockDir, 'box.queue', '1000-lane-a.ticket'), new Date(now - 90_000), new Date(now - 90_000))
writeFileSync(join(lockDir, 'box.queue', '2000-lane-b.ticket'), 'lane-b\n')
utimesSync(join(lockDir, 'box.queue', '2000-lane-b.ticket'), new Date(now - 5_000), new Date(now - 5_000))
const stampedTicket = `${BigInt(now - 60_000) * 1_000_000n}-lane-c.ticket`
writeFileSync(join(lockDir, 'box.queue', stampedTicket), 'lane-c\n')
utimesSync(join(lockDir, 'box.queue', stampedTicket), new Date(now), new Date(now))

section('§1 the lock directory reads as slots, holders and waiters')
const state = box.readBoxLockState(lockDir, now)
check('two slots held, in slot order', state !== null && state.holders.map(h => h.slot).join(',') === '1,3', j(state))
check('the holder line reads as pid, label and clock, with liveness', state?.holders[0]?.pid === process.pid && state.holders[0].label === 'harness-build' && state.holders[0].since === '08:00:00' && state.holders[0].alive === true)
check('a dead holder reads as gone', state?.holders[1]?.pid === 2147483000 && state.holders[1].alive === false)
check('the tickets read as waiters, the oldest first, with the seconds waited', state?.waiters.map(w => `${w.label}:${w.waitedS}`).join(',') === 'lane-a:90,lane-c:60,lane-b:5', j(state?.waiters))
check('a directory that is not there reads null', box.readBoxLockState(join(scratch, 'nowhere'), now) === null)
const words = box.boxLockStateWords(state!)
check('the words name every holder, the gone one, and the waiters', words.includes('harness-build (slot 1, pid') && words.includes('gone-lane (slot 3, pid 2147483000, gone)') && words.includes('3 waiting: lane-a 90s, lane-c 60s, lane-b 5s'), words)

section('§2 the script receipt and the one line')
const receipt = '[box-lock] harness-build holds the box from 08:01:05 (waited 84s; slot box.lock.3)'
const wait = box.boxLockWaitOf(`$ bash with-box-lock.sh harness-build bun run build.ts\n${receipt}\nbuilt`)
check('the receipt reads as label, seconds and slot', wait !== null && wait.label === 'harness-build' && wait.waitedS === 84 && wait.slot === 'box.lock.3', j(wait))
check('output without a receipt reads null', box.boxLockWaitOf('built\n') === null)
check('the flag names the lock directory', (() => {
  process.env.MERCURY_BOX_LOCK_DIR = lockDir
  const dir = box.boxLockDir()
  delete process.env.MERCURY_BOX_LOCK_DIR
  return dir === lockDir
})())
const script = join(scratch, 'with-box-lock.sh')
writeFileSync(script, `#!/bin/bash\nBASE=${lockDir}\nlabel=$1; shift\necho "[box-lock] $label holds the box from 08:01:05 (waited 3s; slot box.lock.2)" >&2\nexec "$@"\n`)
chmodSync(script, 0o755)
check('the BASE= line of the script names the lock directory', box.boxLockDirOfScript(script) === lockDir)
process.env.MERCURY_BOX_LOCK_DIR = lockDir
const line = box.boxLockLineForCommand(`bash ${script} harness-build bun run build.ts`, receipt, { cwd: scratch, now })
delete process.env.MERCURY_BOX_LOCK_DIR
check('the line says how long, who took which slot, who holds, who waits and the load, and ends there', line !== null && line.startsWith('Waited 84 s for the box lock (harness-build took box.lock.3): held by harness-build') && line.includes('3 waiting: lane-a 90s, lane-c 60s') && /load (n\/a|\d+\.\d\d\/core)/.test(line) && line.includes('MB available of') && / MB available of \d+$/.test(line), line ?? 'null')
check('a command that names the script remembers its directory for the facts', box.boxLockDir() === lockDir)
check('a command that did not wait gets no line', box.boxLockLineForCommand(`bash ${script} x true`, '[box-lock] x holds the box from 08:01:05 (waited 0s; slot box.lock)', { cwd: scratch }) === null)
check('a command that names no lock script gets no line', box.boxLockLineForCommand('bun run build.ts', receipt, { cwd: scratch }) === null)

section('§3 the reading the facts carry')
const reading = box.boxReading(now)
check('the reading carries the cores, the load per core (or n/a), and the memory', reading.cores >= 1 && (reading.loadPerCore === null || reading.loadPerCore >= 0) && reading.memory.totalMb > 0 && reading.memory.availableMb >= 0, j(reading))
check('the reading carries the lock state of the remembered directory', reading.lock?.dir === lockDir && reading.lock.holders.length === 2 && reading.lockNote === undefined)
check('an answer before any sample was taken carries the runtime figure, named so, with its clock — it never takes a sample', reading.memory.read === 'free' && reading.memory.sampledAtMs === now, j(reading.memory))
await box.refreshBoxReading()
const sampled = box.boxReading(Date.now())
const source = process.platform === 'darwin' ? 'vm_stat' : process.platform === 'linux' ? 'meminfo' : 'counter'
check(`an answer after the sampler ran reads the last sample (${source}) with the clock it was taken at`, sampled.memory.read === source && sampled.memory.sampledAtMs >= now && sampled.memory.sampledAtMs <= sampled.atMs && sampled.memory.availableMb > 0, j(sampled.memory))
box.rememberBoxLockDir(join(scratch, 'vanished'))
check('a lock directory that vanished is named as such', box.boxReading(now).lock === null && (box.boxReading(now).lockNote ?? '').includes('is not there'))
box.rememberBoxLockDir(lockDir)

section('§4 the wire: the box row crosses in snake_case and decodes back')
const answer = {
  model: { effective: 'm', setting: null },
  usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false },
  identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
  skills: [],
  mcp: [],
  permissionMode: 'default',
  workspace: { cwd: '/w', originalCwd: '/w', projectRoot: '/w', instructionRoots: [] },
  queue: [],
  box: reading,
}
const wire = seatWire.sessionFactsToWire(answer as never) as { box: Record<string, unknown> }
check('the wire spells the box keys snake_case', 'at_ms' in wire.box && 'load_per_core' in wire.box && !('atMs' in wire.box) && 'available_mb' in (wire.box.memory as Record<string, unknown>) && 'sampled_at_ms' in (wire.box.memory as Record<string, unknown>) && 'waited_s' in ((wire.box.lock as { waiters: Record<string, unknown>[] }).waiters[0] ?? {}), j(wire.box))
const back = seatWire.sessionFactsFromWire(JSON.parse(JSON.stringify(wire)))
check('the seat decodes the box row back deep-equal', JSON.stringify(back?.box) === JSON.stringify(reading), j(back?.box))

section('§5 mercury://health/box gives an agent the reading')
const ctx = { owner: { workspace: '/w', sessionId: 'box-proof', lane: 'main' } as never, cwd: scratch }
const resolved = await resolveResource('mercury://health/box', ctx)
check('the box ref resolves', resolved.state === 'ok', j(resolved).slice(0, 200))
const resource = resolved.state === 'ok' ? resolved.resource : null
check('its summary is the load and the lock, nothing after', /^load .* · lock: .*$/.test(resource?.summary ?? '') && (resource?.summary ?? '').includes(lockDir) && !(resource?.summary ?? '').includes('memory guard'), resource?.summary)
check('its structured view is the reading', (resource?.structured as { lock?: { dir?: string } } | undefined)?.lock?.dir === lockDir)
const absent = await resolveResource('mercury://health/nope', ctx)
check('the refs note names the box', absent.state === 'absent' && ((absent as { note?: string }).note ?? '').includes('mercury://health/box'), j(absent))

section('§6 the wiring: the child answers it, the daemon publishes it, the Bash tool speaks it')
check('the runner\'s facts answer carries the reading', readFileSync(join(ROOT, 'src/cli/print.ts'), 'utf8').includes('box: boxReading(),'))
check('the reading takes no sample of its own: it reads the last one and refreshes off the answer', readFileSync(join(ROOT, 'src/utils/boxLock.ts'), 'utf8').includes('const last = lastMemorySample(now)') && !readFileSync(join(ROOT, 'src/utils/boxLock.ts'), 'utf8').includes('sampleAvailableMemory('))
check('the daemon publishes the box row as the child answered it, nothing stamped over it', readFileSync(join(ROOT, 'src/daemon/sessionSeat.ts'), 'utf8').includes("{ box: boxAnswer }"))
check('the Bash tool appends the line to a result that waited', readFileSync(join(ROOT, 'src/tools/BashTool/BashTool.tsx'), 'utf8').includes('boxLockLineForCommand(input.command'))
check('the doctor carries the Box lock row', readFileSync(join(ROOT, 'src/utils/healthReport.ts'), 'utf8').includes("id: 'box-lock'"))

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
