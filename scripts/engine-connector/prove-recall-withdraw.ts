#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const SCRATCH = mkdtempSync(join(tmpdir(), 'recall-withdraw-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const REPO = join(import.meta.dir, '../..')
const SRC = join(REPO, 'src')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)

const { DaemonSessionConnector, RECALL_TAKEN_LINE, RECALL_UNKNOWN_LINE } = await import(join(SRC, 'services/engine-connector/daemonConnector.ts'))
const { NoSessionConnector, NO_CHAT_OPEN } = await import(join(SRC, 'services/engine-connector/noSessionConnector.ts'))
const { createUserMessage } = await import(join(SRC, 'utils/messages/factories.ts'))

type Reply = Record<string, unknown>
type Send = {
  clientMessageId: string
  text: string
  sentAtMs: number
  state: 'pending' | 'delivered' | 'queued' | 'taken'
  mode: 'prompt' | 'bash'
  source?: { text: string; mode: 'prompt' | 'bash'; pastedContents: Record<number, unknown> }
  withdrawing?: true
}
type Guts = {
  sends: Send[]
  echoRows: Map<string, unknown>
  rpc: (req: Reply) => Promise<Reply>
  reconcileQueuedSends: (facts: Record<string, unknown>) => void
  noteSettled: (id: string) => void
  paint: () => void
}

const connector = new DaemonSessionConnector({
  sessionId: 'withdraw-proof',
  runnerId: 'runner-1',
  title: 'withdraw proof',
  projectLabel: 'proof',
  workspaceId: 'ws',
  home: SCRATCH,
  modelKey: 'claude-sonnet-5',
})
const g = connector as unknown as Guts
const rpcLog: Reply[] = []
let answer: (req: Reply) => Promise<Reply> = async () => ({ ok: true, op: 'sessionControl', outcome: 'applied' })
g.rpc = async req => {
  rpcLog.push(req)
  return answer(req)
}
let liveWakes = 0
connector.subscribeLive(() => liveWakes++)
const lastRpc = (): Reply | undefined => rpcLog[rpcLog.length - 1]
const PASTES = { 1: { id: 1, type: 'text', content: 'the pasted lines' } }
const seed = (id: string, text: string, state: Send['state'], atMs: number, extra: Partial<Send> = {}): void => {
  g.sends = [...g.sends, { clientMessageId: id, text, sentAtMs: atMs, state, mode: 'prompt', source: { text, mode: 'prompt', pastedContents: {} }, ...extra }]
  g.echoRows.set(id, { ...(createUserMessage({ content: text }) as object), queued: state === 'queued' })
  g.paint()
}
const painted = (): string => JSON.stringify(connector.records())
const sendOf = (id: string): Send | undefined => g.sends.find(s => s.clientMessageId === id)

section('C1 recallableSend: the latest untaken composer line')
{
  check('nothing sent: nothing to recall', connector.recallableSend() === null)
  const older = randomUUID()
  const latest = randomUUID()
  const takenId = randomUUID()
  seed(older, 'the older words', 'queued', 1000)
  seed(latest, 'the latest words [Pasted text #1 +3 lines]', 'queued', 2000, { source: { text: 'the latest words [Pasted text #1 +3 lines]', mode: 'prompt', pastedContents: PASTES } })
  seed(takenId, 'the taken words', 'taken', 3000)
  g.sends = [...g.sends, { clientMessageId: 'notice:abc', text: 'A background agent completed a task', sentAtMs: 4000, state: 'queued', mode: 'prompt' }]
  const r = connector.recallableSend()
  check('the latest untaken composer line is the one ↑ pulls back (not the older, not the taken, not the notice)', r?.clientMessageId === latest && r?.text === 'the latest words [Pasted text #1 +3 lines]', j(r))
  g.sends = g.sends.filter(s => s.clientMessageId !== 'notice:abc')

  section('C2 withdrawn: the send and its row leave, the composer\'s input comes back')
  answer = async () => ({ ok: true, op: 'sessionControl', outcome: 'applied', withdrawn: true, text: 'the latest words the pasted lines' })
  const before = painted()
  check('the queued row paints before the withdraw', before.includes('the latest words'), before.slice(0, 200))
  liveWakes = 0
  const receipt = await connector.withdrawSend(latest)
  check('the RPC carried the withdraw-send action and the identity on the sessionControl op', lastRpc()?.op === 'sessionControl' && lastRpc()?.action === 'withdraw-send' && lastRpc()?.clientMessageId === latest, j(lastRpc()))
  check('the receipt is withdrawn with the composer\'s own input — the unexpanded words, the pastes, the mode', receipt.withdrawn === true && receipt.text === 'the latest words [Pasted text #1 +3 lines]' && receipt.mode === 'prompt' && j(receipt.pastedContents) === j(PASTES), j(receipt))
  check('the send left the list; the older queued send and the taken one stay', sendOf(latest) === undefined && sendOf(older)?.state === 'queued' && sendOf(takenId)?.state === 'taken', j(g.sends.map(s => [s.text, s.state])))
  check('the echo row is gone from the painted records', !painted().includes('the latest words'), painted().slice(0, 200))
  check('the live listeners woke', liveWakes >= 1, `${liveWakes} wakes`)
  check('the next recall is the older line', connector.recallableSend()?.clientMessageId === older)

  section('C3 taken: the runner\'s word keeps the send and dresses it sent')
  answer = async () => ({ ok: true, op: 'sessionControl', outcome: 'refused', withdrawn: false, reason: 'taken', detail: 'the runner already took the line' })
  const t = await connector.withdrawSend(older)
  check('the receipt is refused, reason taken, with the recall\'s one line', t.withdrawn === false && t.reason === 'taken' && t.detail === RECALL_TAKEN_LINE, j(t))
  check('the send stays, dressed taken, no longer withdrawing', sendOf(older)?.state === 'taken' && sendOf(older)?.withdrawing === undefined, j(sendOf(older)))
  check('its row still paints (a sent row now, without the queued dress)', painted().includes('the older words') && !(JSON.parse(painted()) as Array<{ queued?: boolean }>).some(m => m.queued === true), painted().slice(0, 200))
  check('nothing is recallable any more', connector.recallableSend() === null)

  section('C4 a line the screen knows as taken refuses at once — no RPC')
  const rpcs = rpcLog.length
  const t2 = await connector.withdrawSend(older)
  check('refused taken without asking the daemon', t2.withdrawn === false && t2.reason === 'taken' && rpcLog.length === rpcs, j(t2))
  const stranger = await connector.withdrawSend(randomUUID())
  check('an identity the screen never sent answers the unknown line without asking the daemon', stranger.withdrawn === false && stranger.reason === 'unknown' && stranger.detail === RECALL_UNKNOWN_LINE && rpcLog.length === rpcs, j(stranger))
}

section('C5 a daemon that throws: refused naming it; the send stays queued')
{
  const id = randomUUID()
  seed(id, 'the words behind a dead daemon', 'queued', 5000)
  answer = async () => {
    throw new Error('ECONNREFUSED')
  }
  const r = await connector.withdrawSend(id)
  check('the receipt is refused and names the daemon', r.withdrawn === false && r.reason === 'refused' && r.detail.includes('the daemon is not answering') && r.detail.includes('ECONNREFUSED'), j(r))
  check('the send stays queued, no longer withdrawing', sendOf(id)?.state === 'queued' && sendOf(id)?.withdrawing === undefined, j(sendOf(id)))
  check('…and is still recallable', connector.recallableSend()?.clientMessageId === id)

  section('C6 an older daemon\'s door sentence rides the receipt whole')
  const DOOR = 'the daemon is an older build (protocol 8, v1.0.0-beta.2; this Mercury speaks 9) — `sessionControl withdraw-send` needs protocol 9 — restart the daemon: `mercury daemon restart`'
  answer = async () => ({ ok: false, code: 'EUNKNOWN', error: DOOR, refusal: 'daemon-older' })
  const o = await connector.withdrawSend(id)
  check('the receipt carries the door\'s sentence whole', o.withdrawn === false && o.reason === 'refused' && o.detail === DOOR, j(o))
  check('the send stays queued', sendOf(id)?.state === 'queued')

  section('C7 the facts keep their hands off a send whose withdraw is on its way')
  let release: (r: Reply) => void = () => {}
  answer = () => new Promise<Reply>(resolve => (release = resolve))
  const pending = connector.withdrawSend(id)
  await new Promise(r => setTimeout(r, 10))
  check('the send is marked withdrawing while the runner is asked', sendOf(id)?.withdrawing === true, j(sendOf(id)))
  g.reconcileQueuedSends({ queue: [], atMs: Date.now() + 1, busy: true })
  check('a facts tick that reads the queue without it does NOT dress it taken', sendOf(id)?.state === 'queued', j(sendOf(id)))
  release({ ok: true, op: 'sessionControl', outcome: 'applied', withdrawn: true, text: 'the words behind a dead daemon' })
  const w = await pending
  check('the runner\'s word then takes the send out', w.withdrawn === true && sendOf(id) === undefined, j(w))
  const dup = await connector.withdrawSend(id)
  check('a second withdraw of the gone line answers the unknown line', dup.withdrawn === false && dup.reason === 'unknown', j(dup))
}

section('C8 a pending dispatch is awaited before the runner is asked')
{
  const id = randomUUID()
  seed(id, 'the words still on their way', 'pending', 6000)
  const asked: Reply[] = []
  answer = async req => {
    asked.push(req)
    return { ok: true, op: 'sessionControl', outcome: 'applied', withdrawn: true, text: 'the words still on their way' }
  }
  const pending = connector.withdrawSend(id)
  await new Promise(r => setTimeout(r, 30))
  check('while the dispatch is pending the runner is not asked', asked.length === 0)
  g.sends = g.sends.map(s => (s.clientMessageId === id ? { ...s, state: 'queued' } : s))
  g.noteSettled(id)
  const r = await pending
  check('after the settle the runner is asked once and the line comes back', asked.length === 1 && r.withdrawn === true && r.text === 'the words still on their way', j(r))
}

section('C9 the resting slot')
{
  const rest = new NoSessionConnector()
  check('nothing to recall', rest.recallableSend() === null)
  const r = await rest.withdrawSend()
  check('a withdraw refuses with the no-chat sentence', r.withdrawn === false && r.reason === 'refused' && r.detail === NO_CHAT_OPEN, j(r))
}

section('C10 the composer: ↑ recalls before history; the recall never submits')
{
  const composer = readFileSync(join(SRC, 'components/PromptInput/PromptInput.tsx'), 'utf8')
  const branch = composer.slice(composer.indexOf('onHistoryUp: () => {'), composer.indexOf('onHistoryDown: () => {'))
  check('the ↑ branch pulls back a queued send on an EMPTY composer before walking history', branch.includes("if (input === '' && recallQueuedSend()) return") && branch.indexOf('recallQueuedSend()') < branch.indexOf('history.onHistoryUp()'))
  const helper = composer.slice(composer.indexOf('const recallQueuedSend = useCallback'), composer.indexOf('const helpers: PromptInputHelpers'))
  check('the recall applies the receipt the way history recall does (applyRecalledEntry, the cursor at the end)', helper.includes('applyRecalledEntry(value, receipt.mode, receipt.pastedContents)') && helper.includes('setCursorOffset(value.length)'))
  check('the recall NEVER submits — no submit call, no delivery call, in its body (never a second submit road)', !/\bsubmit\(/.test(helper) && !helper.includes('sendWords(') && !helper.includes('onSubmit('))
  check('a refused withdraw paints ONE line: the receipt\'s own words', helper.includes("addNotification({ key: 'recall-send', text: receipt.detail"))
  const hook = readFileSync(join(SRC, 'hooks/useArrowKeyHistory.tsx'), 'utf8')
  check('history itself is untouched: no recall inside the hook', !hook.includes('recallableSend') && !hook.includes('withdrawSend'))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-recall-withdraw: ALL LAWS HOLD' : `prove-recall-withdraw: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
