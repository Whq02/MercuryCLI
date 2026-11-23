#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod/v4'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'empty-reply-nudge-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'empty-reply-nudge-daemon-'))
for (const k of ['MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'NODE_ENV']) {
  delete process.env[k]
}

const { runEventCore, decideEmptyReplyRecovery } = await import('../../src/engine/loop/turn-machine.ts')
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const { emptyReplyNote, markEmptyReply } = await import('../../src/models/roads/emptyReply.ts')
const errors = (await import('../../src/engine/requests/apiErrorRows.ts')) as Record<string, unknown>

const EMPTY_NUDGE = errors.EMPTY_REPLY_RECOVERY_NUDGE as string | undefined
const isNudgeText = errors.isEmptyReplyRecoveryNudgeText as ((text: string) => boolean) | undefined
const carriesNudge = errors.endsWithEmptyReplyRecoveryNudge as ((messages: unknown[]) => boolean) | undefined

const ASK = 'say what the readme holds, in one line'
const ANSWER = 'the readme holds one heading'
const RETRY_WORDS = 'asked the model for its answer (retry 1 of 1)'
const SPENT_WORDS = 'already asked for its answer once; the turn ends here'
const OLD_WORDS = 'sending the same request again'
const MODEL = 'claude-opus-4-8'
const WHERE_NUDGE = 'EMPTY_REPLY_RECOVERY_NUDGE and its classifiers live in src/engine/requests/apiErrorRows.ts'
const WHERE_RETRY = 'the empty_reply_retry rule in src/engine/loop/turn/noToolReply.ts (decideEmptyReplyRecovery picks retry or surface)'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the empty-reply nudge prover exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

type AnyMsg = Record<string, unknown> & { type?: string; isMeta?: boolean }

function makeTool(name: string): never {
  return {
    name,
    async description() {
      return 'rig tool'
    },
    async prompt() {
      return 'rig tool'
    },
    inputSchema: z.object({ text: z.string().optional() }),
    userFacingName: () => name,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async validateInput() {
      return { result: true }
    },
    async call(input: Record<string, unknown>) {
      return { data: `echo:${(input?.text as string) ?? ''}` }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: String(data),
    }),
  } as never
}

function makeCtx(): Record<string, unknown> {
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: [makeTool('EchoTool')],
      engineModel: MODEL,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => appState,
    setAppState: (f: (prev: never) => never): void => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
}

const allowAll = async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never

type CallRecord = { messages: AnyMsg[]; bytes: string }

function makeModel(script: unknown[][]): { calls: CallRecord[]; callModel: unknown } {
  const calls: CallRecord[] = []
  async function* callModel(req: { messages: unknown[] }): AsyncGenerator<never, void> {
    const idx = calls.length
    calls.push({ messages: [...(req.messages as AnyMsg[])], bytes: JSON.stringify(req.messages) })
    const steps = script[idx]
    if (!steps) throw new Error(`model script exhausted at call ${idx}`)
    for (const s of steps) yield s as never
  }
  return { calls, callModel }
}

type EmptyKind = 'empty' | 'silence' | 'cap'
function emptyTurn(kind: EmptyKind): unknown {
  const m = createAssistantMessage({ content: emptyReplyNote('openai', kind) })
  m.message.stop_reason = 'end_turn'
  markEmptyReply(m, kind)
  return m
}
function textTurn(text: string): unknown {
  const m = createAssistantMessage({ content: text })
  m.message.stop_reason = 'end_turn'
  return m
}
function toolTurn(id: string, input: Record<string, unknown>): unknown {
  const m = createAssistantMessage({ content: [{ type: 'tool_use', id, name: 'EchoTool', input }] as never })
  m.message.stop_reason = 'tool_use'
  return m
}

type Run = {
  calls: CallRecord[]
  notices: string[]
  transitions: Array<{ reason: string; attempt?: number }>
  answers: string[]
  terminal: Record<string, unknown>
}

async function run(script: unknown[][], seed?: unknown[]): Promise<Run> {
  const { calls, callModel } = makeModel(script)
  const gen = runEventCore(
    {
      messages: seed ?? [createUserMessage({ content: ASK })],
      systemPrompt: ['rig system prompt'],
      userContext: {},
      systemContext: {},
      canUseTool: allowAll,
      toolUseContext: makeCtx(),
      querySource: 'sdk',
      deps: {
        callModel: callModel as never,
        autocompact: (async () => ({ wasCompacted: false })) as never,
        microcompact: (async (messages: unknown[]) => ({ messages })) as never,
        uuid: (() => {
          let n = 0
          return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
        })(),
      },
    } as never,
    [],
  )
  const notices: string[] = []
  const transitions: Array<{ reason: string; attempt?: number }> = []
  const answers: string[] = []
  let r = await gen.next()
  while (!r.done) {
    const e = r.value as Record<string, unknown>
    if (e.kind === 'notice') {
      const m = e.message as { content?: unknown; text?: unknown }
      notices.push(String(m.content ?? m.text ?? ''))
    }
    if (e.kind === 'turn_settled') transitions.push(e.transition as { reason: string; attempt?: number })
    if (e.kind === 'assistant_settled' && e.withheld !== true) {
      const content = (e.message as { message?: { content?: unknown } }).message?.content
      if (Array.isArray(content)) {
        for (const b of content as AnyMsg[]) if (b.type === 'text' && typeof b.text === 'string') answers.push(b.text)
      }
    }
    r = await gen.next()
  }
  await new Promise(resolve => setTimeout(resolve, 5))
  return { calls, notices, transitions, answers, terminal: r.value as Record<string, unknown> }
}

function userTexts(msgs: AnyMsg[]): Array<{ text: string; meta: boolean }> {
  const out: Array<{ text: string; meta: boolean }> = []
  for (const m of msgs) {
    if (m.type !== 'user') continue
    const c = (m.message as { content?: unknown } | undefined)?.content
    const meta = m.isMeta === true
    if (typeof c === 'string') out.push({ text: c, meta })
    else if (Array.isArray(c)) {
      for (const b of c as AnyMsg[]) if (b.type === 'text' && typeof b.text === 'string') out.push({ text: b.text, meta })
    }
  }
  return out
}
const lastUserText = (msgs: AnyMsg[]): { text: string; meta: boolean } | undefined => userTexts(msgs).at(-1)
const nudgeCount = (msgs: AnyMsg[]): number => userTexts(msgs).filter(u => isNudgeText !== undefined && isNudgeText(u.text)).length
const assistantRows = (msgs: AnyMsg[]): number => msgs.filter(m => m.type === 'assistant').length
const emptyRetries = (r: Run): number => r.transitions.filter(t => t.reason === 'empty_reply_retry').length

section('N0 — the nudge line is owned beside the fault marker: one bracketed system line')
{
  check('EMPTY_REPLY_RECOVERY_NUDGE is exported from services/api/errors.ts', typeof EMPTY_NUDGE === 'string' && EMPTY_NUDGE.length > 0, 'not exported')
  const oneLine = (s: string | undefined): boolean => typeof s === 'string' && !s.includes('\n') && s.startsWith('[System: ') && s.endsWith(']')
  check('it is a single bracketed system line', oneLine(EMPTY_NUDGE), JSON.stringify(EMPTY_NUDGE) + ' — reword ' + WHERE_NUDGE + ' as one line, starting with [System: and ending with ]')
  check('it asks for the final answer or a tool call', typeof EMPTY_NUDGE === 'string' && /final answer/i.test(EMPTY_NUDGE) && /tool call/i.test(EMPTY_NUDGE), 'the wording must ask for the final answer or a tool call: ' + WHERE_NUDGE)
  check('it says the previous reply was empty', typeof EMPTY_NUDGE === 'string' && /previous reply/i.test(EMPTY_NUDGE) && /empty/i.test(EMPTY_NUDGE), 'the wording must say the previous reply was empty: ' + WHERE_NUDGE)
  check('the classifier accepts the wording and nothing else', isNudgeText !== undefined && EMPTY_NUDGE !== undefined && isNudgeText(EMPTY_NUDGE) && !isNudgeText(ASK) && !isNudgeText(String(errors.STREAM_FAULT_RECOVERY_NUDGE)), 'isEmptyReplyRecoveryNudgeText missing or wrong — it must accept only the nudge constant: ' + WHERE_NUDGE)
  const t = await import('../core-runtime/turnScenarios.ts')
  const { NO_TOOL_RULES, readReply } = await import('../../src/engine/loop/turn/noToolReply.ts')
  const planted = await t.plantReply({ script: [t.fixtures.yields(t.fixtures.empty('empty'))] })
  const retried = await t.drain(NO_TOOL_RULES.find(entry => entry.name === 'empty_reply_retry')!.decide(planted.run as never, planted.iter as never, readReply(planted.iter as never)))
  planted.close()
  const handedRows = (retried.decision as { next?: { messages?: AnyMsg[] } } | undefined)?.next?.messages ?? []
  const added = handedRows.slice((planted.iter.messagesForQuery as unknown[]).length)
  check('the turn machine composes the nudge as an isMeta user message through the constant', t.reasonOf(retried.decision) === 'hand_over empty_reply_retry' && added[0]?.type === 'user' && added[0]?.isMeta === true && (added[0]?.message as { content?: unknown } | undefined)?.content === EMPTY_NUDGE, `${t.reasonOf(retried.decision)} · ${JSON.stringify(added[0])} — after an empty reply the rule hands over with one user row, isMeta true, whose content is the constant`)
  check('the pure decision is unchanged: one retry, then surface', decideEmptyReplyRecovery({ recoveryCount: 0 }).kind === 'continue' && decideEmptyReplyRecovery({ recoveryCount: 1 }).kind === 'surface', 'decideEmptyReplyRecovery (src/engine/loop/turn-machine.ts) must continue at recoveryCount 0 and surface at 1')
}

section('N2 — no thinking-only wording: an empty-marked reply never rides beside a thinking block on either route')
{
  check('no second wording is exported (dead text is refused)', errors.THINKING_ONLY_REPLY_RECOVERY_NUDGE === undefined, 'delete THINKING_ONLY_REPLY_RECOVERY_NUDGE from src/engine/requests/apiErrorRows.ts; the one EMPTY_REPLY_RECOVERY_NUDGE wording serves every empty reply')
}

section('N1 — an empty first reply: the retry carries the nudge as the last user turn, once, and the transcript records one empty_reply_retry')
{
  const r = await run([[emptyTurn('empty')], [textTurn(ANSWER)]])
  check('two model calls (the one retry)', r.calls.length === 2, String(r.calls.length) + ' — ' + WHERE_RETRY + ' must send exactly one retry after an empty first reply')
  check('terminal completed', r.terminal.reason === 'completed', JSON.stringify(r.terminal) + ' — the turn must complete after the retry answers: ' + WHERE_RETRY)
  const first = r.calls[0]!
  const second = r.calls[1]!
  check('the second request is NOT byte-identical to the first', second.bytes !== first.bytes, 'the request was sent again byte-identical — ' + WHERE_RETRY + ' must append the nudge to the retry request')
  const last = lastUserText(second.messages)
  check("the second request's last user turn ends with the empty-reply nudge line", last !== undefined && EMPTY_NUDGE !== undefined && last.text.endsWith(EMPTY_NUDGE), `last user text: ${JSON.stringify(last?.text.slice(-160))} — ${WHERE_RETRY} must end the retry with the constant`)
  check('the nudge rides as an isMeta user message (never rendered as operator input)', last?.meta === true, 'the retry rule must add the nudge as an isMeta user message: ' + WHERE_RETRY)
  check('the nudge appears exactly once in the retry and never in the first request', nudgeCount(second.messages) === 1 && nudgeCount(first.messages) === 0, `first=${nudgeCount(first.messages)} second=${nudgeCount(second.messages)} — ${WHERE_RETRY} must add the nudge once, to the retry only`)
  check('the nudge is the last message of the retry', (second.messages.at(-1) as AnyMsg | undefined)?.type === 'user' && (second.messages.at(-1) as AnyMsg | undefined)?.isMeta === true, 'the nudge must be appended last: ' + WHERE_RETRY)
  check('the empty assistant note stays out of the retry (dropped, as before)', assistantRows(second.messages) === assistantRows(first.messages), `assistant rows: first=${assistantRows(first.messages)} second=${assistantRows(second.messages)} — ${WHERE_RETRY} must drop the empty assistant note from the retry`)
  check('the transcript records exactly one empty_reply_retry, attempt 1', emptyRetries(r) === 1 && r.transitions.find(t => t.reason === 'empty_reply_retry')?.attempt === 1, JSON.stringify(r.transitions) + ' — ' + WHERE_RETRY + ' must record one transition, reason empty_reply_retry, attempt 1')
  check('the notice row reads "asked the model for its answer (retry 1 of 1)"', r.notices.some(t => t.includes(RETRY_WORDS)), JSON.stringify(r.notices).slice(0, 400) + ' — the notice text is written by ' + WHERE_RETRY)
  check('the old "sending the same request again" row is gone', !r.notices.some(t => t.includes(OLD_WORDS)), JSON.stringify(r.notices).slice(0, 400) + ' — remove the old wording from the notice in ' + WHERE_RETRY)
  check("the turn's answer is the retry's reply", r.answers.at(-1) === ANSWER, JSON.stringify(r.answers) + ' — the retry reply must be the settled answer: ' + WHERE_RETRY)
}

section('N3 — a request already carrying the nudge is left alone')
{
  check('endsWithEmptyReplyRecoveryNudge is exported from errors.ts', typeof carriesNudge === 'function', 'not exported — export endsWithEmptyReplyRecoveryNudge from src/engine/requests/apiErrorRows.ts')
  const seed = [createUserMessage({ content: ASK }), createUserMessage({ content: EMPTY_NUDGE ?? '', isMeta: true })]
  check('the predicate sees the nudge at the tail', carriesNudge !== undefined && carriesNudge(seed) === true && carriesNudge([createUserMessage({ content: ASK })]) === false, 'endsWithEmptyReplyRecoveryNudge in src/engine/requests/apiErrorRows.ts must be true only when the last message is the nudge')
  const r = await run([[emptyTurn('empty')], [textTurn(ANSWER)]], seed)
  check('two model calls (the retry still happens)', r.calls.length === 2, String(r.calls.length) + ' — ' + WHERE_RETRY + ' must still retry once when the request already carries the nudge')
  check('the retry carries the nudge exactly once — not appended twice', nudgeCount(r.calls[1]?.messages ?? []) === 1, `count=${nudgeCount(r.calls[1]?.messages ?? [])} — ${WHERE_RETRY} must skip appending when endsWithEmptyReplyRecoveryNudge is true`)
  check('the retry has as many messages as the request that already carried it', (r.calls[1]?.messages.length ?? 0) === (r.calls[0]?.messages.length ?? -1), `${r.calls[0]?.messages.length} → ${r.calls[1]?.messages.length} — ${WHERE_RETRY} must add no message when the nudge is already last`)
}

section('N4 — the bound: a second empty reply surfaces after the one nudged retry')
{
  const r = await run([[emptyTurn('empty')], [emptyTurn('empty')], [textTurn('never reached')]])
  check('exactly two calls — the retry, then the turn ends', r.calls.length === 2, String(r.calls.length) + ' — ' + WHERE_RETRY + ' must surface after one retry')
  check('terminal completed', r.terminal.reason === 'completed', JSON.stringify(r.terminal) + ' — the turn must end completed after the spent retry: ' + WHERE_RETRY)
  check('the spent notice says the model was already asked once', r.notices.some(t => t.includes(SPENT_WORDS)), JSON.stringify(r.notices).slice(0, 400) + ' — the spent notice is written by ' + WHERE_RETRY)
  check('one empty_reply_retry recorded', emptyRetries(r) === 1, JSON.stringify(r.transitions) + ' — ' + WHERE_RETRY + ' must record exactly one empty_reply_retry')
}

section('N5 — after a tool round the nudge follows the tool result; silence and the cap still end the turn without a second request')
{
  const r = await run([[toolTurn('tu_1', { text: 'x' })], [emptyTurn('empty')], [textTurn(ANSWER)]])
  check('three calls: the tool round, the empty reply, the nudged retry', r.calls.length === 3, String(r.calls.length) + ' — ' + WHERE_RETRY + ' must retry after a tool round followed by an empty reply')
  const msgs = r.calls[2]?.messages ?? []
  const resultIdx = msgs.findIndex(m => m.type === 'user' && JSON.stringify((m.message as { content?: unknown }).content).includes('tu_1'))
  const last = msgs.at(-1)
  check('the tool result rides the retry and the nudge is the last message after it', resultIdx !== -1 && last?.type === 'user' && last.isMeta === true && nudgeCount(msgs) === 1 && resultIdx < msgs.length - 1, `result=${resultIdx} of ${msgs.length} — ${WHERE_RETRY} must append the nudge after the tool result`)
  check("the turn's answer is the retry's reply", r.answers.at(-1) === ANSWER, JSON.stringify(r.answers) + ' — the retry reply must be the settled answer: ' + WHERE_RETRY)
  const silence = await run([[emptyTurn('silence')], [textTurn('never reached')]])
  check('silence: one request, no retry, no nudge', silence.calls.length === 1 && emptyRetries(silence) === 0, String(silence.calls.length) + ' — ' + WHERE_RETRY + ' must not retry a silence-kind empty reply')
  const cap = await run([[emptyTurn('cap')], [textTurn('never reached')]])
  check('the output cap: one request, no retry, no nudge', cap.calls.length === 1 && emptyRetries(cap) === 0, String(cap.calls.length) + ' — ' + WHERE_RETRY + ' must not retry a cap-kind empty reply')
}

console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-empty-reply-nudge: ALL LAWS HOLD' : `prove-empty-reply-nudge: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
