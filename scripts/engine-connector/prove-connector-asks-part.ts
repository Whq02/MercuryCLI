#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'connector-asks-part-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { AsksPart } = await import('../../src/engine/connector/daemon/asks.ts')
const { publishSessionAsks, sessionAsksPath } = await import('../../src/engine/connector/seatProjections.ts')
const { getEngineModel } = await import('../../src/models/catalogue/engineModel.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  const hint = 'change the AsksPart method this check calls (readAsks, asks, answerAsk, settleAsk, dropAll, subscribeAsks) in src/engine/connector/daemon/asks.ts until this holds'
  const shown = !ok ? [detail, hint].filter(Boolean).join(' — ') : ''
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const j = (v: unknown): string => JSON.stringify(v)

type Row = Record<string, unknown>
type Reply = Record<string, unknown>
type Neighbours = {
  rows: Row[]
  seatFacts: { model: { effective: string } } | null
  modelKey: string | undefined
  mode: string | null
  modeAsked: number
  asked: Reply[]
  answer: (req: Reply) => Promise<Reply>
  delivered: Array<{ text: string; opts: Row }>
}
let born = 0
function part(over: Partial<Neighbours> = {}): { asks: InstanceType<typeof AsksPart>; n: Neighbours; sessionId: string; publish: (rows: Row[] | null) => void; seen: { wakes: number } } {
  const sessionId = `asks-part-${++born}`
  const n: Neighbours = { rows: [], seatFacts: null, modelKey: undefined, mode: 'default', modeAsked: 0, asked: [], answer: async () => ({ ok: true, outcome: 'applied' }), delivered: [], ...over }
  const seen = { wakes: 0 }
  const asks = new AsksPart({
    record: () => ({ sessionId, ...(n.modelKey !== undefined ? { modelKey: n.modelKey } : {}) }),
    rows: () => n.rows as never,
    facts: () => n.seatFacts as never,
    permissionMode: () => {
      n.modeAsked++
      return n.mode as never
    },
    chainRpc: req => {
      n.asked.push(req)
      return n.answer(req)
    },
    deliver: async (text, opts) => {
      n.delivered.push({ text, opts: opts as Row })
      return { state: 'accepted' } as never
    },
  })
  asks.subscribeAsks(() => void seen.wakes++)
  return {
    asks,
    n,
    sessionId,
    seen,
    publish: rows => {
      if (rows === null) rmSync(sessionAsksPath(sessionId), { force: true })
      else publishSessionAsks({ schema: 1, sessionId, asks: rows as never })
      asks.readAsks()
    },
  }
}
const ask = (n: number, extra: Row = {}): Row => ({ requestId: `ask-${n}`, toolUseId: `toolu_${n}`, toolName: 'Bash', input: { command: `step ${n}` }, description: `run step ${n}`, askedAt: 1000 + n, ...extra })
const turn = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
const detailOf = (receipt: { ok: boolean; detail?: string }): string | undefined => (receipt.ok ? undefined : receipt.detail)

section('§1 the list is what the runner parked, in its order')
{
  const { asks, publish, seen } = part()
  asks.readAsks()
  check('with no projection there is no ask and nobody wakes', asks.asks().length === 0 && seen.wakes === 0)
  publish([])
  check('an empty projection is an empty list, and wakes nobody', asks.asks().length === 0 && seen.wakes === 0)
  publish([ask(1, { cwd: '/work', agentId: 'agent-3', limitMs: 60_000 }), ask(2)])
  const [first, second] = asks.asks()
  check('two parked asks are two entries in the order parked, with one wake', asks.asks().length === 2 && first?.id === 'ask-1' && second?.id === 'ask-2' && seen.wakes === 1)
  check('an entry carries the id, the tool, when it was asked, the crewmate and the limit', first?.toolName === 'Bash' && first.askedAt === 1001 && first.agentId === 'agent-3' && first.limitMs === 60_000 && !('agentId' in second!) && !('limitMs' in second!), j([first, second].map(a => ({ ...a, confirm: undefined }))))
  publish([ask(1, { cwd: '/work', agentId: 'agent-3', limitMs: 60_000 }), ask(2)])
  check('the same asks read again wake nobody and keep the list', seen.wakes === 1 && asks.asks()[0] === first)
  publish([ask(2), ask(3)])
  check('an ask that left is gone, one that stayed keeps its card, a new one joins', j(asks.asks().map(a => a.id)) === j(['ask-2', 'ask-3']) && asks.asks()[0]!.confirm === second!.confirm && seen.wakes === 2)
  publish([ask(1), ask(2), ask(3)])
  check('an ask that comes back is given a new card', asks.asks()[0]!.id === 'ask-1' && asks.asks()[0]!.confirm !== first!.confirm)
  publish(null)
  check('a projection that is gone empties the list and wakes the listeners', asks.asks().length === 0 && seen.wakes === 4)
  publish(null)
  check('…once', seen.wakes === 4)
}

section('§2 the card of an ask: the tool, the input, the words, the record it answers')
{
  const record = { type: 'assistant', uuid: 'row-with-the-call', message: { content: [{ type: 'text', text: 'I will run it' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'step 1' } }] } }
  const { asks, publish, n } = part({ rows: [{ type: 'user', message: { content: 'go' } }, record], seatFacts: { model: { effective: 'the-facts-model' } }, modelKey: 'the-record-model' })
  publish([
    ask(1, { cwd: '/work', decisionReason: 'the rule asks', blockedPath: '/etc/hosts', suggestions: [{ type: 'addRules', rules: [], behavior: 'allow', destination: 'session' }] }),
    ask(2, { toolName: 'mcp__files__write', input: { path: 'a.txt' } }),
  ])
  const [bash, mcp] = asks.asks().map(a => a.confirm)
  check('the card names the real tool, the input, the tool call and the folder', bash!.tool.name === 'Bash' && j(bash!.input) === j({ command: 'step 1' }) && bash!.toolUseID === 'toolu_1' && bash!.cwd === '/work' && bash!.permissionPromptStartTimeMs === 1001)
  check("the card's words are the runner's own description", bash!.description === 'run step 1')
  const result = bash!.permissionResult as { behavior: string; message: string; blockedPath?: string; suggestions?: unknown[]; decisionReason?: { type: string; reason?: string } }
  check('the ask it shows is the one parked: the message, the blocked path, the suggestions, the reason', result.behavior === 'ask' && result.message === 'Bash asks to run' && result.blockedPath === '/etc/hosts' && result.suggestions?.length === 1 && result.decisionReason?.type === 'other' && result.decisionReason.reason === 'the rule asks', j(result))
  check("a card whose call stands in the transcript answers that record", bash!.assistantMessage === (record as never))
  const standIn = mcp!.assistantMessage as { type: string; message: { content: Array<{ type: string; id: string; name: string }> } }
  check('a card whose call no record carries answers a stand-in record of the call', standIn.type === 'assistant' && standIn.message.content[0]?.type === 'tool_use' && standIn.message.content[0].id === 'toolu_2' && standIn.message.content[0].name === 'mcp__files__write')
  check("a tool the screen does not hold is shown under its server's name", mcp!.tool.name === 'mcp__files__write' && mcp!.tool.userFacingName({} as never) === 'files - write (MCP)', mcp!.tool.userFacingName({} as never))
  const context = bash!.toolUseContext as { options: { engineModel: string }; messages: unknown; getAppState: () => unknown }
  let threw = false
  try {
    context.getAppState()
  } catch {
    threw = true
  }
  check("the card's context names the model of the facts, holds the transcript's rows, and has no app state to hand out", context.options.engineModel === 'the-facts-model' && context.messages === n.rows && threw)
  const byRecord = part({ modelKey: 'the-record-model' })
  byRecord.publish([ask(1)])
  const ambient = part()
  ambient.publish([ask(1)])
  const modelOf = (p: ReturnType<typeof part>): string => (p.asks.asks()[0]!.confirm.toolUseContext as { options: { engineModel: string } }).options.engineModel
  check("with no facts the model is the record's, and with neither the ambient one", modelOf(byRecord) === 'the-record-model' && modelOf(ambient) === getEngineModel(), `${modelOf(byRecord)} · ${modelOf(ambient)}`)
  check("a described ask never asks the screen's permission mode", n.modeAsked === 0 && ambient.n.modeAsked === 0)
  const bare = part({ mode: 'plan' })
  bare.publish([ask(1, { description: undefined })])
  await turn()
  check("an ask with no description is first shown under the tool's own name, and its description is asked with the screen's mode", bare.n.modeAsked === 1 && typeof bare.asks.asks()[0]!.confirm.description === 'string' && bare.asks.asks()[0]!.confirm.description !== '', bare.asks.asks()[0]!.confirm.description)
}

section('§3 an answer: the ask leaves at once, the carrier is told, the feedback is sent')
{
  const { asks, publish, n, seen, sessionId } = part()
  publish([ask(1), ask(2), ask(3), ask(4), ask(5), ask(6)])
  const unknown = await asks.answerAsk('ask-9', { kind: 'deny' })
  check('an id no ask carries is refused without asking the carrier', detailOf(unknown) === 'no pending ask carries that id' && n.asked.length === 0 && seen.wakes === 1)
  let release: (reply: Reply) => void = () => {}
  n.answer = () => new Promise<Reply>(resolve => (release = resolve))
  const allowing = asks.answerAsk('ask-1', { kind: 'allow', updatedInput: { command: 'step 1, changed' }, permissionUpdates: [] })
  check('the ask leaves the list and wakes the listeners before the carrier answers', j(asks.asks().map(a => a.id)) === j(['ask-2', 'ask-3', 'ask-4', 'ask-5', 'ask-6']) && seen.wakes === 2)
  release({ ok: true, outcome: 'applied' })
  const allowed = await allowing
  check('an allow tells the carrier the changed input and no empty list of rule changes', allowed.ok === true && j(n.asked[0]) === j({ op: 'sessionControl', action: 'answer-permission', sessionId, by: 'operator', requestId: 'ask-1', allow: true, answer: { updatedInput: { command: 'step 1, changed' } } }), j(n.asked[0]))
  n.answer = async () => ({ ok: true, outcome: 'applied' })
  await asks.answerAsk('ask-2', { kind: 'deny', feedback: 'not that one' })
  check('a deny tells the carrier the feedback, and sends nothing to the session', j(n.asked[1]!.answer) === j({ feedback: 'not that one' }) && n.asked[1]!.allow === false && n.delivered.length === 0)
  await asks.answerAsk('ask-3', { kind: 'abort' })
  check('an abort tells the carrier to interrupt', j(n.asked[2]!.answer) === j({ interrupt: true }) && n.asked[2]!.allow === false)
  await asks.answerAsk('ask-4', { kind: 'allow', feedback: '  and be careful  ' })
  check('feedback on an allow is sent to the session as its own words, trimmed', n.delivered.length === 1 && n.delivered[0]!.text === 'and be careful' && j(n.asked[3]!.answer) === j({}))
  const blocks = [{ type: 'text', text: 'a block' }]
  await asks.answerAsk('ask-5', { kind: 'deny', contentBlocks: blocks as never })
  check('content blocks on a deny are sent too, with no words', n.delivered.length === 2 && n.delivered[1]!.text === '' && n.delivered[1]!.opts.extraBlocks === blocks)
  n.answer = async () => ({ ok: true, outcome: 'refused', detail: 'the ask was answered elsewhere' })
  const late = await asks.answerAsk('ask-6', { kind: 'allow', feedback: 'too late' })
  check("a carrier that did not apply it answers with its own detail, and the feedback is not sent", detailOf(late) === 'the ask was answered elsewhere' && n.delivered.length === 2)
  publish([ask(7), ask(8), ask(9)])
  n.answer = async () => ({ ok: false, error: 'no such session' })
  const refused = await asks.answerAsk('ask-7', { kind: 'allow' })
  n.answer = async () => ({ ok: false })
  const silent = await asks.answerAsk('ask-8', { kind: 'allow' })
  n.answer = async () => {
    throw new Error('ECONNREFUSED')
  }
  const dead = await asks.answerAsk('ask-9', { kind: 'allow' })
  check('a refusal carries the error, a silent one the default sentence, a carrier that throws is named unreachable', detailOf(refused) === 'no such session' && detailOf(silent) === 'the ask was already answered' && detailOf(dead) === 'the daemon was unreachable — ECONNREFUSED', j([refused, silent, dead]))
}

section("§4 the card's own buttons, settling, and dropping every ask")
{
  const { asks, publish, n, seen } = part()
  publish([ask(1), ask(2), ask(3), ask(4), ask(5)])
  const card = (id: string): { onAllow: (...a: unknown[]) => Promise<void>; onReject: (...a: unknown[]) => Promise<void>; onAbort: () => void } => asks.asks().find(a => a.id === id)!.confirm as never
  await card('ask-1').onAllow({ command: 'changed' }, [{ type: 'addRules' }], 'thanks', undefined)
  check('the allow button answers through the same road: the input, the rule changes, the feedback', j(n.asked[0]!.answer) === j({ updatedInput: { command: 'changed' }, permissionUpdates: [{ type: 'addRules' }] }) && n.delivered[0]?.text === 'thanks')
  await card('ask-2').onReject('no', undefined)
  check('the reject button denies with the feedback', n.asked[1]!.allow === false && j(n.asked[1]!.answer) === j({ feedback: 'no' }))
  card('ask-3').onAbort()
  await turn()
  check('the abort button interrupts', j(n.asked[2]!.answer) === j({ interrupt: true }))
  const before = seen.wakes
  asks.settleAsk('ask-4')
  asks.settleAsk('ask-4')
  check('settling an ask takes it off the list once, with one wake and no word to the carrier', j(asks.asks().map(a => a.id)) === j(['ask-5']) && seen.wakes === before + 1 && n.asked.length === 3)
  asks.dropAll()
  check('dropping every ask empties the list and wakes the listeners', asks.asks().length === 0 && seen.wakes === before + 2)
  asks.dropAll()
  check('…and wakes them again on an empty list, as the interrupt always has', seen.wakes === before + 3)
  let left = 0
  const off = asks.subscribeAsks(() => void left++)
  off()
  asks.dropAll()
  check('a listener that left is not woken', left === 0)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-connector-asks-part: the part holds' : `\nprove-connector-asks-part: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
