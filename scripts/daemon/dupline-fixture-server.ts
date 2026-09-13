#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  AGENT_DESCRIPTION,
  AGENT_PROMPT,
  AGENT_TURN_ASK,
  CREW_TURN_ASK,
  DEEPER_DONE,
  DEEPER_PROMPT,
  doneText,
  FOLD_MARKER,
  FOLD_PROMPT,
  FOLD_SUMMARY_MARK,
  FOLD_TRIGGER_INPUT_TOKENS,
  FOLD_TURN_ASK,
  FORK_DONE,
  FORK_PROMPT,
  FORK_TURN_ASK,
  NESTED_PROMPT,
  NESTED_TURN_ASK,
  QUICK_DESCRIPTION,
  QUICK_DONE,
  QUICK_PROMPT,
  RELAUNCH_PROMPT,
  RELAUNCH_TURN_ASK,
  SLEEP_TOOL_PROMPT,
  SLEEP_TOOL_TURN_ASK,
  THREE_ROUNDS_ASK,
  WATCHED_WORDS,
  WORKFLOW_AGENT_DONE,
  WORKFLOW_NAME,
  WORKFLOW_PROMPT,
  WORKFLOW_TURN_ASK,
} from './dupline-fixture-words.ts'

const captureFile = process.argv[2]
if (!captureFile) {
  console.error('usage: dupline-fixture-server.ts <captureFile> [agentSleepSeconds] [mainSleepSeconds] [foldPaceMs]')
  process.exit(2)
}
export const AGENT_SLEEP_SECONDS = Number(process.argv[3] ?? 20)
export const MAIN_SLEEP_SECONDS = Number(process.argv[4] ?? 6)
export const FOLD_PACE_MS = Number(process.argv[5] ?? 800)

const sse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
const j = (v: unknown): string => JSON.stringify(v)
const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)
function record(entry: Record<string, unknown>): void {
  appendFileSync(captureFile, `${JSON.stringify(entry)}\n`)
}
type Block = { type?: string; text?: string; tool_use_id?: string; id?: string; name?: string; content?: unknown; is_error?: boolean }
type Item = { role?: string; content?: unknown }
function itemsOf(body: Record<string, unknown>): Item[] {
  return Array.isArray(body.messages) ? (body.messages as Item[]) : []
}
function askOf(content: unknown): string {
  if (typeof content === 'string') return content.trimStart().startsWith('<system-reminder>') ? '' : content
  if (!Array.isArray(content)) return ''
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i] as Block
    if (part.type === 'text' && typeof part.text === 'string' && !part.text.trimStart().startsWith('<system-reminder>')) return part.text
  }
  return ''
}
function isToolResultItem(item: Item): boolean {
  return item.role === 'user' && Array.isArray(item.content) && (item.content as Block[]).some(p => p.type === 'tool_result')
}
function askIndexOf(items: Item[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.role === 'user' && askOf(item.content) !== '') return i
  }
  return -1
}
function firstAsk(items: Item[]): string {
  for (const item of items) {
    if (item.role === 'user') {
      const a = askOf(item.content)
      if (a !== '') return a
    }
  }
  return ''
}
function textOfBlocks(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[])
    .map(part => {
      if (typeof part.text === 'string') return part.text
      if (part.type === 'tool_result') return textOfBlocks(part.content)
      return ''
    })
    .join('\n')
}
function messagesText(items: Item[]): string {
  return items.map(item => textOfBlocks(item.content)).join('\n')
}
function lastToolResultOf(items: Item[]): { isError: boolean; text: string } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (!isToolResultItem(item)) continue
    const results = (item.content as Block[]).filter(p => p.type === 'tool_result')
    const last = results[results.length - 1]!
    return { isError: last.is_error === true, text: textOfBlocks(last.content).slice(0, 200) }
  }
  return null
}
function countOf(raw: string, word: string): number {
  let n = 0
  let at = raw.indexOf(word)
  while (at >= 0) {
    n++
    at = raw.indexOf(word, at + word.length)
  }
  return n
}

let calls = 0
const usage = { input_tokens: 21, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 9 }
type Usage = typeof usage
function openMessage(res: ServerResponse, n: number, model: string, u: Usage = usage): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(sse('message_start', { type: 'message_start', message: { id: `msg_dupline_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...u, output_tokens: 1 } } }))
}
const closeMessage = (stop: 'end_turn' | 'tool_use', index: number, u: Usage = usage): string =>
  sse('content_block_stop', { type: 'content_block_stop', index }) +
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: u }) +
  sse('message_stop', { type: 'message_stop' })
function answerText(res: ServerResponse, n: number, model: string, text: string): void {
  openMessage(res, n, model)
  res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }))
  res.end(closeMessage('end_turn', 0))
}
type ToolCall = { id: string; name: string; input: Record<string, unknown> }
function answerTools(res: ServerResponse, n: number, model: string, calls: ToolCall[], u: Usage = usage): void {
  openMessage(res, n, model, u)
  calls.forEach((call, index) => {
    res.write(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } }))
    res.write(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } }))
    if (index < calls.length - 1) res.write(sse('content_block_stop', { type: 'content_block_stop', index }))
  })
  res.end(closeMessage('tool_use', calls.length - 1, u))
}
const answerTool = (res: ServerResponse, n: number, model: string, id: string, name: string, input: Record<string, unknown>, u: Usage = usage): void =>
  answerTools(res, n, model, [{ id, name, input }], u)
const answerSleep = (res: ServerResponse, n: number, model: string, id: string, seconds: number, u: Usage = usage): void =>
  answerTool(res, n, model, id, 'Bash', { command: `sleep ${seconds}`, description: `a ${seconds}s sleep` }, u)
const answerAgent = (res: ServerResponse, n: number, model: string, id: string, prompt: string, extra: Record<string, unknown> = {}): void =>
  answerTool(res, n, model, id, 'Agent', { description: AGENT_DESCRIPTION, prompt, ...extra })
const FOLD_DELTAS = [
  '<analysis>the walk</analysis>',
  '<summary>1. Operator Intent: ',
  `${FOLD_SUMMARY_MARK}. `,
  '2. Technical Ground: none. 3. Files and Code Touched: none. 4. Errors and Corrections: none. 5. Problems Worked: none. 6. Operator Messages: the sub agent fold work. 7. Open Work: none. 8. Where Work Stands: idle. 9. Next Move (optional): none. 10. Agents in flight: none.',
  '</summary>',
]
function answerFold(res: ServerResponse, n: number, model: string): void {
  openMessage(res, n, model)
  res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  let i = 0
  const step = (): void => {
    if (res.destroyed || res.writableEnded) return
    if (i < FOLD_DELTAS.length) {
      res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: FOLD_DELTAS[i]! } }))
      i++
      setTimeout(step, FOLD_PACE_MS).unref()
      return
    }
    res.end(closeMessage('end_turn', 0))
    record({ kind: 'fold-landed', n, at: Date.now() })
  }
  step()
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    const url = (req.url ?? '').split('?')[0] ?? ''
    if (!(req.method === 'POST' && url.endsWith('/v1/messages'))) {
      record({ kind: 'hit', method: req.method, url, at: Date.now() })
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `no fixture route for ${req.method} ${url}` } }))
      return
    }
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {
    }
    const n = ++calls
    const model = typeof body.model === 'string' ? body.model : 'fixture'
    const tools = Array.isArray(body.tools) ? body.tools.length : 0
    const toolNames = Array.isArray(body.tools) ? (body.tools as Array<{ name?: string }>).map(t => String(t.name ?? '')) : []
    const items = itemsOf(body)
    const askIndex = askIndexOf(items)
    const ask = askIndex === -1 ? '' : askOf(items[askIndex]!.content)
    const opening = firstAsk(items)
    const step = askIndex === -1 ? 0 : items.slice(askIndex + 1).filter(isToolResultItem).length
    const trimmedAsk = ask.trim()
    const openingTrimmed = opening.trim()
    const folded = messagesText(items).includes(FOLD_SUMMARY_MARK)
    const subArm =
      openingTrimmed === AGENT_PROMPT
        ? 'subwork'
        : openingTrimmed === SLEEP_TOOL_PROMPT
          ? 'subsleep'
          : openingTrimmed === FOLD_PROMPT || folded
            ? 'subfold'
            : openingTrimmed === NESTED_PROMPT
              ? 'subnested'
              : openingTrimmed === DEEPER_PROMPT
                ? 'deeper'
                : openingTrimmed === FORK_PROMPT
                  ? 'forkwork'
                  : openingTrimmed === QUICK_PROMPT
                    ? 'quick'
                    : openingTrimmed === WORKFLOW_PROMPT
                      ? 'wfwork'
                      : openingTrimmed === RELAUNCH_PROMPT
                        ? 'subrelaunch'
                        : null
    const mainArm =
      trimmedAsk === AGENT_TURN_ASK
        ? 'agent'
        : trimmedAsk === SLEEP_TOOL_TURN_ASK
          ? 'agentsleep'
          : trimmedAsk === CREW_TURN_ASK
            ? 'crew'
            : trimmedAsk === FOLD_TURN_ASK
              ? 'agentfold'
              : trimmedAsk === NESTED_TURN_ASK
                ? 'agentnested'
                : trimmedAsk === FORK_TURN_ASK
                  ? 'agentfork'
                  : trimmedAsk === WORKFLOW_TURN_ASK
                    ? 'agentworkflow'
                    : trimmedAsk === RELAUNCH_TURN_ASK
                      ? 'agentrelaunch'
                      : trimmedAsk === THREE_ROUNDS_ASK
                        ? 'three'
                        : 'plain'
    const arm = subArm ?? mainArm
    const fold = raw.includes(FOLD_MARKER)
    const text = messagesText(items)
    const counts: Record<string, number> = {}
    const firstAt: Record<string, number> = {}
    for (const w of WATCHED_WORDS) {
      counts[w] = countOf(text, w)
      const at = text.indexOf(w)
      if (at >= 0) firstAt[w] = at
    }
    record({ kind: fold ? 'fold' : 'request', n, arm, step, folded, ask: ask.slice(0, 80), opening: opening.slice(0, 40), tools, hasAgentTool: toolNames.includes('Agent'), hasWorkflowTool: toolNames.includes('Workflow'), hasSleepTool: toolNames.includes('Sleep'), lastToolResult: lastToolResultOf(items), at: Date.now(), system: sha(j(body.system)), counts, firstAt })
    if (fold) return answerFold(res, n, model)
    switch (arm) {
      case 'agent':
        if (step === 0) return answerAgent(res, n, model, `toolu_agent_c${n}`, AGENT_PROMPT)
        return answerText(res, n, model, doneText(AGENT_TURN_ASK))
      case 'agentsleep':
        if (step === 0) return answerAgent(res, n, model, `toolu_agent_c${n}`, SLEEP_TOOL_PROMPT)
        return answerText(res, n, model, doneText(SLEEP_TOOL_TURN_ASK))
      case 'crew':
        if (step === 0)
          return answerTools(res, n, model, [
            { id: `toolu_quick_c${n}`, name: 'Agent', input: { description: QUICK_DESCRIPTION, prompt: QUICK_PROMPT, run_in_background: true } },
            { id: `toolu_agent_c${n}`, name: 'Agent', input: { description: AGENT_DESCRIPTION, prompt: AGENT_PROMPT } },
          ])
        return answerText(res, n, model, doneText(CREW_TURN_ASK))
      case 'agentfold':
        if (step === 0) return answerAgent(res, n, model, `toolu_agent_c${n}`, FOLD_PROMPT)
        return answerText(res, n, model, doneText(FOLD_TURN_ASK))
      case 'agentnested':
        if (step === 0) return answerAgent(res, n, model, `toolu_agent_c${n}`, NESTED_PROMPT)
        return answerText(res, n, model, doneText(NESTED_TURN_ASK))
      case 'agentfork':
        if (step === 0) return answerAgent(res, n, model, `toolu_fork_c${n}`, FORK_PROMPT, { subagent_type: 'fork' })
        if (step === 1) return answerAgent(res, n, model, `toolu_agent_c${n}`, AGENT_PROMPT)
        return answerText(res, n, model, doneText(FORK_TURN_ASK))
      case 'agentworkflow':
        if (step === 0) return answerTool(res, n, model, `toolu_wf_c${n}`, 'Workflow', { name: WORKFLOW_NAME })
        if (step === 1) return answerSleep(res, n, model, `toolu_wfwait_c${n}`, MAIN_SLEEP_SECONDS * 2)
        return answerText(res, n, model, doneText(WORKFLOW_TURN_ASK))
      case 'agentrelaunch':
        if (step === 0) return answerAgent(res, n, model, `toolu_agent_c${n}`, RELAUNCH_PROMPT)
        return answerText(res, n, model, doneText(RELAUNCH_TURN_ASK))
      case 'subwork':
        if (step === 0) return answerSleep(res, n, model, `toolu_sub_c${n}`, AGENT_SLEEP_SECONDS)
        return answerText(res, n, model, 'agent done: the sub agent finished')
      case 'subsleep':
        if (step === 0) return answerTool(res, n, model, `toolu_subsleep_c${n}`, 'Sleep', { seconds: AGENT_SLEEP_SECONDS })
        return answerText(res, n, model, 'agent done: the sleeping sub agent finished')
      case 'subfold':
        if (!folded) {
          if (step === 0) return answerSleep(res, n, model, `toolu_prefold_c${n}`, 3, { ...usage, input_tokens: FOLD_TRIGGER_INPUT_TOKENS })
          return answerText(res, n, model, 'agent done: the sub agent finished without folding')
        }
        if (step === 0) return answerSleep(res, n, model, `toolu_postfold_c${n}`, 2)
        return answerText(res, n, model, 'agent done: the folded sub agent finished')
      case 'subnested':
        if (step === 0) return answerSleep(res, n, model, `toolu_subnest_c${n}`, AGENT_SLEEP_SECONDS)
        if (step === 1) return answerTool(res, n, model, `toolu_deeper_c${n}`, 'Agent', { description: 'deeper work', prompt: DEEPER_PROMPT })
        return answerText(res, n, model, 'agent done: the nesting sub agent finished')
      case 'deeper':
        return answerText(res, n, model, DEEPER_DONE)
      case 'forkwork':
        return answerText(res, n, model, FORK_DONE)
      case 'quick':
        return answerText(res, n, model, QUICK_DONE)
      case 'wfwork':
        if (step === 0) return answerSleep(res, n, model, `toolu_wfagent_c${n}`, 4)
        return answerText(res, n, model, WORKFLOW_AGENT_DONE)
      case 'subrelaunch':
        if (step === 0) return answerSleep(res, n, model, `toolu_relaunch1_c${n}`, AGENT_SLEEP_SECONDS)
        if (step === 1) return answerSleep(res, n, model, `toolu_relaunch2_c${n}`, MAIN_SLEEP_SECONDS * 4)
        return answerText(res, n, model, 'agent done: the relaunch sub agent finished')
      case 'three':
        if (step === 0) return answerSleep(res, n, model, `toolu_r1_c${n}`, MAIN_SLEEP_SECONDS)
        if (step === 1) return answerSleep(res, n, model, `toolu_r2_c${n}`, 3)
        if (step === 2) return answerSleep(res, n, model, `toolu_r3_c${n}`, 2)
        return answerText(res, n, model, doneText(THREE_ROUNDS_ASK))
      default: {
        const heard = ask === '' || tools === 0 ? 'svc' : `heard: ${trimmedAsk.split('\n').pop()} (#${n})`
        return answerText(res, n, model, heard)
      }
    }
  })
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  console.log(`PORT ${port}`)
})

const shutdown = (): void => {
  server.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
const parentPid = process.ppid
const parentGone = (): boolean => {
  try {
    process.kill(parentPid, 0)
    return false
  } catch (err) {
    return (err as { code?: string }).code === 'ESRCH'
  }
}
setInterval(() => {
  if (process.ppid !== parentPid || parentGone()) shutdown()
}, 1000).unref()
