#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Database } from 'bun:sqlite'
import { Client, type CallToolResult } from '@modelcontextprotocol/client'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = join(proofHome, 'work')
mkdirSync(join(root, '.mercury'), { recursive: true, mode: 0o700 })
const { switchSession, setOriginalCwd } = await import('../../src/bootstrap/state.ts')
setOriginalCwd(root)
switchSession('00000000-0000-4000-8000-000000000051' as never, root)
const { procStartToken } = await import('../../src/utils/genericProcessUtils.ts')
const { getProcessStartTokenAsync } = await import('../../src/daemon/ownerWatch.ts')
const leases = await import('../../src/services/vulcan/engine/leases.ts')
const { createMercuryServer, withMercuryLeaseHolder } = await import('../../src/services/mcp/mercuryServer.ts')
const { createLinkedTransportPair } = await import('../../src/services/mcp/InProcessTransport.ts')

const ROWS = 150_000
const TREE = 'art/pack/'
const STEP_BOUND_MS = 5_000
const BULK_RELEASE_BOUND_MS = 3_000
const CONCURRENT_BOUND_MS = 5_000
const ABANDON_MS = 10_000

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600)}` : ''}`)
}
type Timed<T> = { ms: number; value: T | undefined; abandoned: boolean }
async function timed<T>(work: () => Promise<T>): Promise<Timed<T>> {
  const started = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const abandon = new Promise<'abandoned'>(resolve => { timer = setTimeout(() => resolve('abandoned'), ABANDON_MS) })
  try {
    const outcome = await Promise.race([work().then(value => ({ value })), abandon])
    const ms = performance.now() - started
    return outcome === 'abandoned' ? { ms, value: undefined, abandoned: true } : { ms, value: outcome.value, abandoned: false }
  } finally {
    clearTimeout(timer)
  }
}
const describeStep = (step: Timed<unknown>): string => step.abandoned ? `still running after ${ABANDON_MS} ms` : `${step.ms.toFixed(0)} ms`
const within = (step: Timed<unknown>, bound: number): boolean => {
  console.log(`  step: ${describeStep(step)} (bound ${bound} ms)`)
  return !step.abandoned && step.ms <= bound
}
const rss = (): string => `${(process.memoryUsage().rss / 1e6).toFixed(0)} MB rss`

const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'inherit'] })
await once(child, 'spawn')
const childDone = once(child, 'close')
const treeOwner = { sessionId: 'c0ffee00-0000-4000-8000-000000000001', agentId: 'tree-owner', pid: child.pid!, procStart: procStartToken(child.pid!) ?? (await getProcessStartTokenAsync(child.pid!)) ?? undefined }

function seed(holder: { sessionId: string; agentId: string; pid: number; procStart?: string }, rows: number): void {
  const db = new Database(join(root, '.mercury', 'project-leases.sqlite'))
  db.exec('PRAGMA journal_mode = DELETE; CREATE TABLE IF NOT EXISTS leases (path TEXT PRIMARY KEY, record TEXT NOT NULL)')
  const insert = db.prepare('INSERT INTO leases (path, record) VALUES (?, ?)')
  const acquiredAt = new Date().toISOString()
  db.exec('BEGIN')
  for (let i = 0; i < rows; i++) {
    const path = `${TREE}set-${String(Math.floor(i / 100)).padStart(4, '0')}/frame-${String(i).padStart(6, '0')}.png`
    insert.run(path, JSON.stringify({ path, holder, acquiredAt }))
  }
  db.exec('COMMIT')
  db.close()
}
seed(treeOwner, ROWS)
const storeBytes = statSync(join(root, '.mercury', 'project-leases.sqlite')).size
console.log(`store: ${ROWS} old-shape rows for ${treeOwner.agentId} (pid ${treeOwner.pid}), ${(storeBytes / 1e6).toFixed(1)} MB; ${rss()}`)

const second = leases.projectLeaseHolder('second')
const server = await createMercuryServer()
const client = new Client({ name: 'lease-scale-proof', version: '0' })
const [a, b] = createLinkedTransportPair()
type LeaseCallResult = CallToolResult & { structuredContent?: Record<string, unknown> }
const call = (name: string, args: Record<string, unknown>, agentId?: string): Promise<LeaseCallResult> => withMercuryLeaseHolder(agentId, () => client.callTool({ name, arguments: args })) as Promise<LeaseCallResult>

try {
  await Promise.all([server.connect(a), client.connect(b)])

  const take = await timed(() => leases.takeProjectLeases(root, ['src/second.ts'], second))
  check(`a second holder takes one file beside ${ROWS} foreign rows within ${STEP_BOUND_MS} ms`, within(take, STEP_BOUND_MS) && take.value?.ok === true, describeStep(take))
  check('its result counts its own leases and lists them, not the table', take.value?.ok === true && take.value.held === 1 && take.value.leases.length === 1 && take.value.under === 'src/', take.value)

  const migrated = new Database(join(root, '.mercury', 'project-leases.sqlite'), { readonly: true })
  const columns = (migrated.prepare('PRAGMA table_info(leases)').all() as Array<{ name: string }>).map(row => row.name)
  const unfilled = Number((migrated.prepare('SELECT COUNT(*) AS n FROM leases WHERE session IS NULL OR agent IS NULL OR pid IS NULL').get() as { n: number }).n)
  const indexed = migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'leases_holder_path'").all().length
  migrated.close()
  check('the first operation adds the holder columns and index and fills them from every old-shape record', ['session', 'agent', 'pid', 'proc_start'].every(column => columns.includes(column)) && unfilled === 0 && indexed === 1, { columns, unfilled, indexed })

  const conflict = await timed(() => leases.takeProjectLeases(root, [`${TREE}set-0042/frame-004242.png`], second))
  check(`a take of a foreign row is refused within ${STEP_BOUND_MS} ms and names the holder read from the old-shape record`, within(conflict, STEP_BOUND_MS) && conflict.value?.ok === false && conflict.value.message === `${TREE}set-0042/frame-004242.png is leased by session ${treeOwner.sessionId}, agent ${treeOwner.agentId} (pid ${treeOwner.pid})`, { step: describeStep(conflict), value: conflict.value })

  const listing = await timed(() => leases.describeProjectLeases(root))
  const owner = listing.value?.holders.find(row => row.holder.agentId === treeOwner.agentId)
  check(`list completes within ${STEP_BOUND_MS} ms`, within(listing, STEP_BOUND_MS), describeStep(listing))
  check('list is one row per holder: the tree owner with its count and the directory its rows share, no paths', listing.value?.total === ROWS + 1 && listing.value.holders.length === 2 && owner?.count === ROWS && owner.under === TREE && !('leases' in listing.value), listing.value && { ...listing.value, leases: listing.value.leases?.length })
  const listingBytes = JSON.stringify(listing.value, null, 2).length
  check('the list result stays under 4 KB at 150,000 rows', listingBytes < 4096, `${listingBytes} bytes`)

  const served = await timed(() => call('lease_list', {}))
  const servedHolders = served.value?.structuredContent?.holders as Array<{ count: number; under: string }> | undefined
  check(`lease_list through the in-process server answers within ${STEP_BOUND_MS} ms with the holder rows`, within(served, STEP_BOUND_MS) && served.value?.isError !== true && served.value?.structuredContent?.total === ROWS + 1 && servedHolders?.some(row => row.count === ROWS && row.under === TREE) === true && served.value?.structuredContent?.leases === undefined, { step: describeStep(served), text: JSON.stringify(served.value?.content).slice(0, 400) })
  const servedText = (served.value?.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? ''
  check('the served text is the same small summary', servedText.length < 4096 && servedText.includes(`"count": ${ROWS}`), `${servedText.length} chars`)

  const named = await timed(() => call('lease_list', { agentId: treeOwner.agentId, sessionId: treeOwner.sessionId }))
  const namedLeases = named.value?.structuredContent?.leases as Array<{ path: string }> | undefined
  check(`naming the tree owner lists its first ${leases.LEASE_DETAIL_LIMIT} paths in order within ${STEP_BOUND_MS} ms, beside its count`, within(named, STEP_BOUND_MS) && namedLeases?.length === leases.LEASE_DETAIL_LIMIT && namedLeases[0]?.path === `${TREE}set-0000/frame-000000.png` && (named.value?.structuredContent?.holders as Array<{ count: number }>).some(row => row.count === ROWS), { step: describeStep(named), got: namedLeases?.length })

  const burst = await timed(() => Promise.all(Array.from({ length: 17 }, () => leases.describeProjectLeases(root))))
  check(`17 concurrent list callers in one process all finish within ${CONCURRENT_BOUND_MS} ms`, within(burst, CONCURRENT_BOUND_MS) && burst.value?.every(row => row.total === ROWS + 1) === true, describeStep(burst))

  const release = await timed(() => leases.releaseProjectLeases(root, second, ['src/second.ts']))
  check(`the second holder releases its file within ${STEP_BOUND_MS} ms and the result counts it`, within(release, STEP_BOUND_MS) && release.value?.released === 1 && release.value.paths.length === 1, { step: describeStep(release), value: release.value })

  const bulk = await timed(() => leases.releaseProjectLeases(root, treeOwner))
  const afterBulk = await leases.describeProjectLeases(root)
  check(`the tree owner's ${ROWS} rows go in one release within ${BULK_RELEASE_BOUND_MS} ms; the result counts them and shows ${leases.LEASE_DETAIL_LIMIT}`, within(bulk, BULK_RELEASE_BOUND_MS) && bulk.value?.released === ROWS && bulk.value.paths.length === leases.LEASE_DETAIL_LIMIT && afterBulk.total === 0, { step: describeStep(bulk), released: bulk.value?.released, after: afterBulk.total })
  console.log(`after the foreign release: ${rss()}`)

  const bulkAgent = leases.projectLeaseHolder('bulk-agent')
  seed(bulkAgent, ROWS)
  const controller = new AbortController()
  const end = leases.beginAgentProjectLeases('bulk-agent', controller.signal)
  const own = await timed(() => leases.takeProjectLeases(root, [`${TREE}extra.png`], bulkAgent))
  check(`the agent holding ${ROWS} rows takes one more within ${STEP_BOUND_MS} ms and its result names the tree`, within(own, STEP_BOUND_MS) && own.value?.ok === true && own.value.held === ROWS + 1 && own.value.under === TREE && own.value.leases.length === leases.LEASE_DETAIL_LIMIT, { step: describeStep(own), value: own.value?.ok === true ? { ...own.value, leases: own.value.leases.length } : own.value })
  controller.abort()
  const ending = await timed(() => end())
  const afterEnd = await leases.describeProjectLeases(root)
  check(`the agent's end releases its ${ROWS + 1} rows within ${BULK_RELEASE_BOUND_MS} ms`, within(ending, BULK_RELEASE_BOUND_MS) && afterEnd.total === 0, { step: describeStep(ending), after: afterEnd.total })
  console.log(`after the agent end: ${rss()}`)

  const gone = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  const [goneStart] = await Promise.all([Promise.resolve(procStartToken(gone.pid!) ?? getProcessStartTokenAsync(gone.pid!)), once(gone, 'close')])
  seed({ sessionId: 'c0ffee00-0000-4000-8000-000000000002', agentId: 'departed', pid: gone.pid!, procStart: goneStart ?? undefined }, ROWS)
  const sweep = await timed(() => leases.describeProjectLeases(root))
  check(`${ROWS} rows of a departed process are swept by one list within ${BULK_RELEASE_BOUND_MS} ms`, within(sweep, BULK_RELEASE_BOUND_MS) && sweep.value?.total === 0, { step: describeStep(sweep), total: sweep.value?.total })
} finally {
  child.stdin.end()
  await childDone
  await server.close()
  await client.close()
  rmSync(proofHome, { recursive: true, force: true })
}
console.log(`${checks} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
