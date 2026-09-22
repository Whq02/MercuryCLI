#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'dispatch-receipts-decode-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
const DEBUG_LOG = join(scratch, 'debug.txt')
process.argv.push(`--debug-file=${DEBUG_LOG}`)

const { getCwd } = await import('../../src/utils/cwd.js')
const { dispatchToAgent, listDeliveryReceipts, readDeliveryReceipt } = await import(
  '../../src/services/crew/dispatch.js'
)
const { readStoreRecoveryEvents } = await import('../../src/substrate/storeRecovery.js')
const { flushDebugLogs } = await import('../../src/utils/debug.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const dir = join(scratch, 'crew')
mkdirSync(dir, { recursive: true })
const key = createHash('sha256').update(getCwd()).digest('hex').slice(0, 16)
const path = join(dir, `receipts-${key}.json`)

const receipt = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 1,
  clientMessageId: id,
  state: 'delivered',
  requestedAddress: { agentId: 'agent:a' },
  requestedDisposition: 'hold-next',
  instructionOutcome: 'accepted',
  attachmentOutcomes: [],
  observedAt: 1_700_000_000_000,
  ...extra,
})

try {
  section('(1) a null row and a row without its state are dropped; the whole rows read')
  {
    writeFileSync(
      path,
      JSON.stringify({
        _v: 1,
        receipts: [
          null,
          receipt('no-state', { state: undefined }),
          receipt('good'),
          receipt('address-a-string', { requestedAddress: 'agent:a' }),
          'nope',
        ],
        settledIds: ['s-1', 7, null, 's-2'],
      }),
    )
    let found: unknown
    try {
      found = await readDeliveryReceipt('good', { dir })
    } catch (e) {
      found = `threw: ${e}`
    }
    check(
      'the good receipt is found by its id, without a throw',
      typeof found === 'object' && found !== null && (found as { clientMessageId?: string }).clientMessageId === 'good',
      String(found),
    )
    let listed: unknown
    try {
      listed = await listDeliveryReceipts({ dir })
    } catch (e) {
      listed = `threw: ${e}`
    }
    check(
      'the listing carries the good receipt alone',
      Array.isArray(listed) && listed.length === 1 && listed[0].clientMessageId === 'good',
      JSON.stringify(listed),
    )
    await flushDebugLogs()
    const named = (existsSync(DEBUG_LOG) ? readFileSync(DEBUG_LOG, 'utf8') : '')
      .split('\n')
      .filter(l => l.includes('crew-dispatch-receipts') && l.includes('not decodable'))
    check('the dropped rows are named once across the reads', named.length === 1, `${named.length} line(s)`)
  }

  section('(2) a settled id survives the filter: a replay of it is refused by the guard')
  {
    const draft = {
      clientMessageId: 's-2',
      requestedAddress: { agentId: 'agent:a' },
      requestedDisposition: 'hold-next',
      instruction: 'again',
      attachments: [],
    }
    const replay = await dispatchToAgent(draft as never, { dir })
    check(
      'the replayed settled id is refused on the replay guard, never re-delivered',
      replay.state === 'not-delivered' && replay.route === 'replay-guard',
      JSON.stringify(replay),
    )
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { receipts: unknown[] }
    check('the refusal is not persisted and the ring still holds the null and the bad rows untouched', onDisk.receipts.length === 5)
  }

  section('(3) an envelope whose receipts is not an array takes the store\'s own damaged road')
  {
    writeFileSync(path, JSON.stringify({ _v: 1, receipts: 42, settledIds: [] }))
    const listed = await listDeliveryReceipts({ dir })
    check('the read degrades to empty', Array.isArray(listed) && listed.length === 0)
    let ev: { path: string } | undefined
    for (let i = 0; i < 40 && ev === undefined; i++) {
      const events = await readStoreRecoveryEvents()
      ev = events.find(e => e.store === 'crew-dispatch-receipts' && e.kind === 'read-degrade')
      if (ev === undefined) await sleep(50)
    }
    check('the degrade is on the recovery ledger under the store\'s name and path', ev !== undefined && ev.path === path, JSON.stringify(ev))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? '✅ DISPATCH RECEIPT DECODE PROOFS PASS' : `❌ ${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
