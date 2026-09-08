#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
const SCRATCH = mkdtempSync(join(tmpdir(), 'held-for-compaction-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const REPO = join(import.meta.dir, '../..')
const SRC = join(REPO, 'src')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)

const { DaemonSessionConnector } = await import(join(SRC, 'services/engine-connector/daemonConnector.ts'))
const { createUserMessage } = await import(join(SRC, 'utils/messages/factories.ts'))
const { HELD_PLATE, QUEUED_PLATE, HELD_FOR_COMPACTION_LINE } = await import(join(SRC, 'components/messages/TranscriptNameplate.tsx'))

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
  sessionId: 'held-proof',
  runnerId: 'runner-1',
  title: 'held proof',
  projectLabel: 'proof',
  workspaceId: 'ws',
  home: SCRATCH,
  modelKey: 'claude-sonnet-5',
})
const g = connector as unknown as Guts
g.rpc = async () => ({ ok: true, op: 'sessionControl', outcome: 'applied', withdrawn: true, text: 'the words' })
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

section('H1 a send during the compaction is held, and says so')
const held = randomUUID()
seed(held, 'continue the job from the receipt', 'delivered')
foldRunning(true)
g.dressSend(held, 'queued')
check('the send record reads queued and held for the compaction', sendOf(held)?.state === 'queued' && sendOf(held)?.heldFor === 'compaction', j(sendOf(held)))
check('the echo row wears the held dress beside the queued one', rowOf(held)?.queued === true && rowOf(held)?.heldFor === 'compaction', j(rowOf(held)))
check('the plate word is held, in the queued column (same width)', HELD_PLATE === 'held'.padEnd(8) && HELD_PLATE.length === QUEUED_PLATE.length)
check('the composer line says until when and how to take it back', HELD_FOR_COMPACTION_LINE.includes('held until the compaction lands') && HELD_FOR_COMPACTION_LINE.includes('delivers once') && HELD_FOR_COMPACTION_LINE.includes('↑'))

section('H2 the compaction lands: the same send, delivered once')
const before = g.sends.length
foldRunning(false)
check('one send record, the same identity — nothing was re-sent', g.sends.length === before && sendOf(held) !== undefined, j(g.sends.map(s => [s.clientMessageId, s.state, s.heldFor])))
check('the held dress leaves; the send reads plain queued until the runner takes it', sendOf(held)?.state === 'queued' && sendOf(held)?.heldFor === undefined && rowOf(held)?.queued === true && rowOf(held)?.heldFor === undefined, j(rowOf(held)))
g.dressSend(held, 'taken')
check("the runner's word takes it: the row loses the queued dress and gets its sent time", sendOf(held)?.state === 'taken' && rowOf(held)?.queued === undefined && rowOf(held)?.heldFor === undefined && typeof rowOf(held)?.timestamp === 'string', j(rowOf(held)))

section('H3 a send queued before the compaction becomes held when it begins')
const early = randomUUID()
seed(early, 'sent before the fold', 'queued')
check('queued, not held, while the runner runs a plain turn', sendOf(early)?.heldFor === undefined)
foldRunning(true)
check('the compacting word holds it', sendOf(early)?.heldFor === 'compaction' && rowOf(early)?.heldFor === 'compaction', j(sendOf(early)))

section('H4 heldForCompaction lists exactly the held sends')
const late = randomUUID()
seed(late, 'sent during the fold', 'delivered')
g.dressSend(late, 'queued')
check('both queued sends are held', j(connector.heldForCompaction().sort()) === j([early, late].sort()), j(connector.heldForCompaction()))
check('the taken one is not', !connector.heldForCompaction().includes(held))
foldRunning(false)
check('nothing is held once the fold lands', connector.heldForCompaction().length === 0)

section('H5 the recall road stays open on a held send')
foldRunning(true)
const recall = connector.recallableSend()
check('↑ still finds the latest held line', recall?.clientMessageId === late, j(recall))
const receipt = await connector.withdrawSend(late)
check('…and withdraws it on the runner\'s word', receipt.withdrawn === true && sendOf(late) === undefined, j(receipt))
foldRunning(false)
const settled = randomUUID()
seed(settled, 'sent during a fold the turn settled', 'queued')
foldRunning(true)
check('held while the fold runs', sendOf(settled)?.heldFor === 'compaction')
g.factsBusy = false
g.setLiveStateWord('waiting-on-agents')
check('the turn settling clears the held dress through the recompute road', sendOf(settled)?.heldFor === undefined && g.liveStateWord === null, j([sendOf(settled), g.liveStateWord]))

section('H6 the composer and the plate (source pins)')
const repl = readFileSync(join(SRC, 'screens/REPL.tsx'), 'utf8')
check("the composer says the held line on a send while the focused seat's phase is compacting", repl.includes("if (getFocusedSeatLive().phase === 'compacting') {") && repl.includes("key: 'held-for-compaction'") && repl.includes('text: HELD_FOR_COMPACTION_LINE'))
const plate = readFileSync(join(SRC, 'components/messages/TranscriptNameplate.tsx'), 'utf8')
check('the plate paints held in place of queued when the meta says so', plate.includes("meta.heldFor === 'compaction' ? HELD_PLATE : QUEUED_PLATE"))
const message = readFileSync(join(SRC, 'components/Message.tsx'), 'utf8')
check('the row hands the held reason to the plate', message.includes("heldFor === 'compaction' ? { heldFor: 'compaction' as const } : {}"))

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
