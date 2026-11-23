#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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

const { DaemonSessionConnector, RECALL_TAKEN_LINE, RECALL_UNKNOWN_LINE } = await import(join(SRC, 'engine/connector/daemonConnector.ts'))
const { NoSessionConnector, NO_CHAT_OPEN } = await import(join(SRC, 'engine/connector/noSessionConnector.ts'))
const { createUserMessage } = await import(join(SRC, 'engine/message-shapes/factories.ts'))

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
  reconcileQueuedSends: (facts: Record<string, unknown>) => void
  noteSettled: (id: string) => void
  paint: () => void
}

const rpcLog: Reply[] = []
let answer: (req: Reply) => Promise<Reply> = async () => ({ ok: true, op: 'sessionControl', outcome: 'applied' })
const connector = new DaemonSessionConnector({
  sessionId: 'withdraw-proof',
  runnerId: 'runner-1',
  title: 'withdraw proof',
  projectLabel: 'proof',
  workspaceId: 'ws',
  home: SCRATCH,
  modelKey: 'claude-sonnet-5',
}, {
  rpc: async (req: Reply) => {
    rpcLog.push(req)
    return answer(req)
  },
})
const g = connector as unknown as Guts
let liveWakes = 0
connector.subscribeLive(() => liveWakes++)
const lastRpc = (): Reply | undefined => rpcLog[rpcLog.length - 1]
const PASTES = { 1: { id: 1, type: 'text', content: 'the pasted lines' } }
const painted = (): string => JSON.stringify(connector.records())

section('C9 the resting slot')
{
  const rest = new NoSessionConnector()
  check('nothing to recall', rest.recallableSend() === null, 'NoSessionConnector.recallableSend in src/engine/connector/noSessionConnector.ts must return null')
  const r = await rest.withdrawSend()
  check('a withdraw refuses with the no-chat sentence', r.withdrawn === false && r.reason === 'refused' && r.detail === NO_CHAT_OPEN, `${j(r)} — NoSessionConnector.withdrawSend in src/engine/connector/noSessionConnector.ts must return withdrawn:false, reason:'refused', detail:NO_CHAT_OPEN`)
}


rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-recall-withdraw: ALL LAWS HOLD' : `prove-recall-withdraw: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
