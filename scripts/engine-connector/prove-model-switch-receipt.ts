#!/usr/bin/env bun
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

section("L10 the daemon's words reach the operator whenever they say more than the switch itself")
{
  const exitWords = 'the runner had exited at 06:05 (crashed mid-run (exit none · signal SIGKILL)) and is back — runner-1 → claude-opus-5'
  answer = async () => ({ ok: true, outcome: 'applied', detail: 'runner-1 → claude-opus-5' })
  const plain = (await switchTo('claude-opus-5')) as Receipt & { note?: string }
  check('the plain "<runner> → <model>" receipt paints as before: applied, no note', plain.state === 'applied' && plain.note === undefined, JSON.stringify(plain))
  answer = async () => ({ ok: true, outcome: 'applied', detail: exitWords })
  const back = (await switchTo('claude-opus-5')) as Receipt & { note?: string }
  check('a switch that landed in place on a runner the record still shows as exited carries the daemon\'s words as the note (no respawned flag on the reply)', back.state === 'applied' && back.note === exitWords, JSON.stringify(back))
  const restartWords = 'the runner had exited at 06:05 (crashed mid-run (exit none · signal SIGKILL)) — restarting on Fable 5.1'
  answer = async () => ({ ok: true, outcome: 'applied', detail: restartWords, respawned: true })
  const respawned = (await switchTo('claude-opus-5')) as Receipt & { note?: string }
  check('the respawn receipt keeps its note', respawned.state === 'applied' && respawned.note === restartWords, JSON.stringify(respawned))
  answer = async () => ({ ok: true, outcome: 'applied' })
  const bare = (await switchTo('claude-opus-5')) as Receipt & { note?: string }
  check('an applied reply with no detail carries no note', bare.state === 'applied' && bare.note === undefined, JSON.stringify(bare))
  const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')
  check('/model paints the note in its notice', read('commands/model/model.tsx').includes('${receipt.note !== undefined ? ` (${receipt.note})` : \'\'}'))
  check('the model surface paints the note in its notice', read('commands/model/mercuryModel.tsx').includes('${receipt.note !== undefined ? ` (${receipt.note})` : \'\'}'))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-model-switch-receipt: ALL PASS' : `\nprove-model-switch-receipt: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
