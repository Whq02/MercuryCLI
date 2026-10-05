#!/usr/bin/env bun
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
const SCRATCH = mkdtempSync(join(tmpdir(), 'fold-line-never-held-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const SRC = join(import.meta.dir, '../../src')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)

const { DaemonSessionConnector } = await import(join(SRC, 'services/engine-connector/daemonConnector.ts'))
const { createUserMessage } = await import(join(SRC, 'utils/messages/factories.ts'))

type Send = { clientMessageId: string; text: string; sentAtMs: number; state: 'pending' | 'delivered' | 'queued' | 'taken'; heldFor?: 'compaction'; mode: 'prompt' | 'bash' }
type Guts = {
  sends: Send[]
  echoRows: Map<string, { queued?: true; heldFor?: 'compaction'; timestamp?: string }>
  rpc: (req: Record<string, unknown>) => Promise<Record<string, unknown>>
  dressSend: (id: string, state: Send['state']) => void
  setLiveStateWord: (word: 'compacting' | 'waiting-on-agents' | null, agentsWaiting?: number) => void
  liveStateWord: 'compacting' | 'waiting-on-agents' | null
  factsBusy: boolean
  paint: () => void
}

const connector = new DaemonSessionConnector({
  sessionId: 'fold-line-proof',
  runnerId: 'runner-1',
  title: 'fold line proof',
  projectLabel: 'proof',
  workspaceId: 'ws',
  home: SCRATCH,
  modelKey: 'claude-sonnet-5',
})
const g = connector as unknown as Guts
g.rpc = async () => ({ ok: true, op: 'sessionControl', outcome: 'applied' })
const seed = (id: string, text: string, state: Send['state']): void => {
  g.sends = [...g.sends, { clientMessageId: id, text, sentAtMs: Date.now(), state, mode: 'prompt', source: { text, mode: 'prompt', pastedContents: {} } } as Send]
  g.echoRows.set(id, { ...(createUserMessage({ content: text }) as object), ...(state === 'queued' ? { queued: true } : {}) })
  g.paint()
}
const sendOf = (id: string): Send | undefined => g.sends.find(s => s.clientMessageId === id)
const rowOf = (id: string) => g.echoRows.get(id)
const foldRunning = (on: boolean): void => {
  g.factsBusy = on
  g.setLiveStateWord(on ? 'compacting' : null)
}

section('§1 the fold\'s own line: a queued /compact the runner takes never wears held while its facts tick is still on its way')
const compactLine = randomUUID()
seed(compactLine, '/compact', 'queued')
check('queued while the runner runs the turn before it', sendOf(compactLine)?.state === 'queued' && sendOf(compactLine)?.heldFor === undefined, j(sendOf(compactLine)))
foldRunning(true)
check('RED ON THE BASE: the compacting word flips and the /compact line stays plain queued — it is the compaction, not a line held for it', sendOf(compactLine)?.heldFor === undefined && rowOf(compactLine)?.heldFor === undefined, j([sendOf(compactLine), rowOf(compactLine)]))
check('…and the held list does not name it', !connector.heldForCompaction().includes(compactLine), j(connector.heldForCompaction()))
g.dressSend(compactLine, 'taken')
check('the facts tick takes it: a sent row with its time, no plate', sendOf(compactLine)?.state === 'taken' && rowOf(compactLine)?.queued === undefined && rowOf(compactLine)?.heldFor === undefined && typeof rowOf(compactLine)?.timestamp === 'string', j(rowOf(compactLine)))

section('§2 a line sent during the fold is held at its own enqueue, and the plate leaves when the fold lands')
const during = randomUUID()
seed(during, 'carry on from the receipt', 'delivered')
g.dressSend(during, 'queued')
check('held for the compaction, on the send and its row', sendOf(during)?.heldFor === 'compaction' && rowOf(during)?.heldFor === 'compaction' && rowOf(during)?.queued === true, j([sendOf(during), rowOf(during)]))
check('the held list names exactly it', j(connector.heldForCompaction()) === j([during]), j(connector.heldForCompaction()))
g.dressSend(during, 'queued')
check('a facts tick that re-reads it queued keeps the hold while the fold runs', sendOf(during)?.heldFor === 'compaction', j(sendOf(during)))
foldRunning(false)
check('the fold lands: plain queued, one record, until the runner takes it', sendOf(during)?.state === 'queued' && sendOf(during)?.heldFor === undefined && rowOf(during)?.queued === true && rowOf(during)?.heldFor === undefined, j([sendOf(during), rowOf(during)]))
check('nothing is held once the fold lands', connector.heldForCompaction().length === 0)

section('§3 a line queued before the fold began keeps its dress through the flip — never a plate the flip put there')
const before = randomUUID()
seed(before, 'sent before the fold', 'queued')
foldRunning(true)
check('the flip leaves it plain queued', sendOf(before)?.heldFor === undefined && rowOf(before)?.heldFor === undefined, j(sendOf(before)))
const later = randomUUID()
seed(later, 'sent during this fold', 'delivered')
g.dressSend(later, 'queued')
check('a line sent during the same fold is held beside it', sendOf(later)?.heldFor === 'compaction' && j(connector.heldForCompaction()) === j([later]), j(connector.heldForCompaction()))
foldRunning(false)
check('the landing clears the one plate; both read plain queued', sendOf(before)?.heldFor === undefined && sendOf(later)?.heldFor === undefined && sendOf(before)?.state === 'queued' && sendOf(later)?.state === 'queued')

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '✅ prove-fold-line-never-held: a hold is the send\'s own enqueue\'s, never the flip\'s' : `❌ prove-fold-line-never-held: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
