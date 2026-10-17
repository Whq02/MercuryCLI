#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cut-off-turn-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'cut-off-turn-daemon-'))
for (const k of ['MERCURY_BARE', 'MERCURY_MODEL', 'NODE_ENV']) delete process.env[k]
const scratch = mkdtempSync(join(tmpdir(), 'cut-off-turn-cwd-'))
process.chdir(scratch)

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { loadConversationForResume, getResumePrompt } = await import('../../src/utils/conversationRecovery.ts')
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
import type { Message } from '../../src/types/message.ts'

const SENTENCE = 'The previous run ended before its turn finished — stopped from outside or crashed; continue from where you left off.'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
  if (!cond) failures = 1
}

const T0 = Date.parse('2026-10-16T12:40:00.000Z')
let clock = 0
let uuidCounter = 0
const uid = (): string => `00000000-0000-4000-8000-${String(100000000000 + ++uuidCounter).slice(1)}`
type Row = Record<string, unknown>
function chainRows(sessionId: string, rows: Row[]): Row[] {
  let parent: string | null = null
  return rows.map(row => {
    const uuid = row['uuid'] as string
    const out: Row = { parentUuid: parent, isSidechain: false, cwd: scratch, sessionId, version: '1.0.0-beta.1', gitBranch: 'main', timestamp: new Date(T0 + 30_000 * clock++).toISOString(), ...row }
    parent = uuid
    return out
  })
}
const prompt = (text: string): Row => ({ uuid: uid(), type: 'user', message: { role: 'user', content: text } })
const reply = (content: unknown[]): Row => ({ uuid: uid(), type: 'assistant', requestId: `req_${uuidCounter}`, message: { id: `msg_${uuidCounter}`, type: 'message', role: 'assistant', model: 'claude-fable-5-1', stop_reason: null, stop_sequence: null, container: null, context_management: null, content } })
const toolResult = (toolUseId: string, text: string): Row => ({ uuid: uid(), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] }, toolUseResult: { stdout: text, stderr: '', interrupted: false, isImage: false, noOutputExpected: false } })

async function resume(name: string, rows: Row[]) {
  const sessionId = `${name}-0000-4000-8000-000000000000`
  const file = join(scratch, `${sessionId}.jsonl`)
  const chained = chainRows(sessionId, rows)
  writeFileSync(file, chained.map(r => encodeTranscriptLine(file, r).line).join(''))
  const loaded = await loadConversationForResume(sessionId, file)
  if (!loaded) throw new Error(`the loader returned null for ${name}`)
  return loaded
}
const textOf = (m: Message | undefined): string => {
  const content = (m as { message?: { content?: unknown } } | undefined)?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(b => (b as { text?: string }).text ?? '').join('')
  return ''
}
const userTexts = (messages: Message[]): string[] => messages.filter(m => m.type === 'user').map(m => textOf(m))

console.log('§1 the field shape (F37A-1D-52): the run was killed while it waited on the model after a tool result — the resumed transcript names the cut-off turn')
{
  const loaded = await resume('cutoff01', [
    prompt('create the files, then run npm test'),
    reply([{ type: 'text', text: 'Writing the files now.' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }]),
    toolResult('tu1', '10 pass, 0 fail'),
  ])
  const state = loaded.turnInterruptionState
  check('the turn is read as interrupted and the continuation is the synthetic row', state.kind === 'interrupted_prompt' && state.message.isMeta === true, JSON.stringify(state).slice(0, 200))
  check('the continuation sentence names the cut-off: stopped from outside or crashed', state.kind === 'interrupted_prompt' && textOf(state.message) === SENTENCE, state.kind === 'interrupted_prompt' ? textOf(state.message) : state.kind)
  check('getResumePrompt() is that sentence, byte for byte', getResumePrompt() === SENTENCE, getResumePrompt())
  const texts = userTexts(loaded.messages)
  check('the resumed transcript carries the sentence once, as its last user row, after the tool result', texts.filter(t => t === SENTENCE).length === 1 && texts[texts.length - 1] === SENTENCE, JSON.stringify(texts))
  const last = loaded.messages[loaded.messages.length - 1]
  check('the synthetic assistant sentinel follows it, so the conversation stays valid', last?.type === 'assistant' && textOf(last) === 'No response requested.', JSON.stringify(last).slice(0, 200))
  check('the old bare sentence is gone', !texts.some(t => t === 'Continue from where you left off.'))
}

console.log('§2 the controls: a finished turn gets no sentence; a prompt with no reply is re-asked as itself')
{
  const finished = await resume('finished1', [
    prompt('say hello'),
    reply([{ type: 'text', text: 'Hello.' }]),
  ])
  check('a transcript ending on a completed reply reads as none, with no synthetic row', finished.turnInterruptionState.kind === 'none' && !userTexts(finished.messages).includes(SENTENCE) && finished.messages.length === 2, JSON.stringify({ kind: finished.turnInterruptionState.kind, rows: finished.messages.length }))
  const unanswered = await resume('unanswer1', [
    prompt('say hello'),
    reply([{ type: 'text', text: 'Hello.' }]),
    prompt('and now goodbye'),
  ])
  const state = unanswered.turnInterruptionState
  check("a prompt the model never answered is the interrupted prompt itself — the operator's words, not the sentence", state.kind === 'interrupted_prompt' && textOf(state.message) === 'and now goodbye' && !userTexts(unanswered.messages).includes(SENTENCE), JSON.stringify(state).slice(0, 200))
  const midTool = await resume('midtool01', [
    prompt('run the build'),
    reply([{ type: 'tool_use', id: 'tu9', name: 'Bash', input: { command: 'npm run build' } }]),
  ])
  check('a run killed while its tool ran drops the unresolved tool use and re-asks the prompt', midTool.turnInterruptionState.kind === 'interrupted_prompt' && textOf(midTool.turnInterruptionState.message) === 'run the build' && !userTexts(midTool.messages).includes(SENTENCE), JSON.stringify(midTool.turnInterruptionState).slice(0, 200))
}

console.log(failures === 0 ? '\nprove-cut-off-turn-continuation: ALL PASS' : '\nprove-cut-off-turn-continuation: FAIL')
process.exit(failures)
