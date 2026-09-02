#!/usr/bin/env bun
// ============================================================================
//  prove-model-switch-receipt — the model-switch receipt is the daemon's
//  word: refused, applied, queued or no-op come from the authority that
//  decided them, never from the screen's own guess (release-hardening audit
//  rank 50).
//
//  The lie: the connector's setModel fired the set-model RPC with a void
//  chainRpc and returned a receipt before the daemon answered — "applied"
//  or "queued" by the screen's in-flight view. The transcript printed
//  "Model set to <name> — this session's next message runs it" and the chip
//  flipped while the session never switched (no live worker record, the
//  control channel not writable, the roster not ready, the RPC timing out);
//  the only trace was a debug line, and the chip silently reverted on the
//  next facts read. Both consumers were written for a receipt that can
//  refuse and never received one.
//
//    L1 the daemon's refusal is the receipt, with its detail
//    L2 a failed control channel is a refusal naming the error
//    L3 a thrown RPC (unreachable, timeout) is a refusal naming it
//    L4 the daemon's parked verdict wins over the screen's idle guess
//    L5 applied · L6 no-op — the daemon's words, verbatim
//    L7 the same model no-ops without a wire spend
//    L8 the resting slot's refusal is awaited the same way
//    L9 the three consumers wait for the receipt (source pins)
//
//  The connector is real; its rpc seam is a scripted daemon. PROVE_SRC names
//  another checkout's src (the A/B control: L1-L4, L6 and L9 read red at
//  the pre-fix tree — a receipt minted before the answer).
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'model-switch-receipt-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { DaemonSessionConnector } = await import(join(SRC, 'services/engine-connector/daemonConnector.ts'))
const { NoSessionConnector } = await import(join(SRC, 'services/engine-connector/noSessionConnector.ts'))

type Reply = Record<string, unknown>
type Receipt = { state: string; detail?: string }
const connector = new DaemonSessionConnector({
  sessionId: 'receipt-proof',
  runnerId: 'runner-1',
  title: 'receipt proof',
  projectLabel: 'proof',
  workspaceId: 'ws',
  home: SCRATCH,
  modelKey: 'claude-sonnet-5',
})
const rpcLog: Reply[] = []
let answer: () => Promise<Reply> = async () => ({ ok: true, outcome: 'applied' })
// The daemon door, scripted: chainRpc rides the instance's own rpc.
;(connector as unknown as { rpc: (req: Reply) => Promise<Reply> }).rpc = async req => {
  rpcLog.push(req)
  return answer()
}
const switchTo = async (model: string): Promise<Receipt> => (await connector.setModel(model)) as Receipt
const lastRpc = (): Reply | undefined => rpcLog[rpcLog.length - 1]

section('L1 the daemon\'s refusal is the receipt')
{
  answer = async () => ({ ok: true, outcome: 'refused', detail: 'no live worker record for the session' })
  const receipt = await switchTo('claude-opus-5')
  check('the receipt is refused', receipt.state === 'refused', JSON.stringify(receipt))
  check('with the daemon\'s detail', receipt.detail?.includes('no live worker record') === true, receipt.detail)
  check('the set-model RPC carried the target', lastRpc()?.action === 'set-model' && lastRpc()?.model === 'claude-opus-5', JSON.stringify(lastRpc()))
}

section('L2 a failed control channel is a refusal naming the error')
{
  answer = async () => ({ ok: false, error: 'control channel not writable' })
  const receipt = await switchTo('claude-opus-5')
  check('refused, naming the channel error', receipt.state === 'refused' && receipt.detail?.includes('control channel not writable') === true, JSON.stringify(receipt))
}

section('L3 a thrown RPC is a refusal naming it')
{
  answer = () => Promise.reject(new Error('ETIMEDOUT after 8000ms'))
  const receipt = await switchTo('claude-opus-5')
  check('refused: the daemon is not answering', receipt.state === 'refused' && /not answering/.test(receipt.detail ?? '') && /ETIMEDOUT/.test(receipt.detail ?? ''), JSON.stringify(receipt))
}

section('L4 the daemon\'s parked verdict wins over the screen\'s idle guess')
{
  answer = async () => ({ ok: true, outcome: 'queued' })
  const receipt = await switchTo('claude-opus-5')
  check('the screen\'s view is idle, yet the receipt says queued', receipt.state === 'queued', JSON.stringify(receipt))
}

section('L5 applied · L6 no-op — the daemon\'s words')
{
  answer = async () => ({ ok: true, outcome: 'applied' })
  check('applied', (await switchTo('claude-opus-5')).state === 'applied')
  answer = async () => ({ ok: true, outcome: 'noop', detail: 'already on it' })
  check('the daemon\'s noop is the receipt\'s no-op', (await switchTo('claude-opus-5')).state === 'no-op')
}

section('L7 the same model no-ops without a wire spend')
{
  const before = rpcLog.length
  const receipt = await switchTo('claude-sonnet-5')
  check('no-op', receipt.state === 'no-op', JSON.stringify(receipt))
  check('no RPC went out', rpcLog.length === before, `${rpcLog.length - before} extra`)
}

section('L8 the resting slot\'s refusal is awaited the same way')
{
  const resting = new NoSessionConnector()
  const receipt = (await resting.setModel('claude-opus-5')) as Receipt
  check('refused with the birth-door sentence', receipt.state === 'refused' && typeof receipt.detail === 'string' && receipt.detail.length > 0, JSON.stringify(receipt))
}

section('L9 the consumers wait for the receipt (source pins)')
{
  const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')
  check('the interface declares the door asynchronous', /setModel\(setting: ModelSetting\): Promise<ModelSwitchReceiptV1>/.test(read('services/engine-connector/types.ts')))
  check('/model awaits the door', read('commands/model/model.tsx').includes('await focused.setModel(target)'))
  check('the inline picker waits for the door', read('components/PromptInput/PromptInput.tsx').includes('focused.setModel(value).then('))
  check('the model surface waits for the door', read('commands/model/mercuryModel.tsx').includes('focused.setModel(value).then('))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-model-switch-receipt: ALL PASS' : `\nprove-model-switch-receipt: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
