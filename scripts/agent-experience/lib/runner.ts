import { spawn } from 'node:child_process'
import { isSession, isOutcome, parseFrame } from '../../lib/rows.ts'

export interface RunSpec {
  dist: string
  nodeBin: string
  cwd: string
  env: Record<string, string>
  model: string
  prompt: string
  allowedTools: string[]
  maxTurns: number
  permissionMode: string
  sessionId?: string
  resume?: string
  timeoutMs: number
}

export interface ToolUse {
  id: string
  name: string
  input: Record<string, unknown>
  messageId: string
  parentToolUseId: string | null
}

export interface ToolResult {
  id: string
  text: string
  isError: boolean
  imageChars: number
  parentToolUseId: string | null
}

export interface RunRecord {
  spec: RunSpec
  envelopes: Array<Record<string, unknown>>
  assistantMessages: Array<{ messageId: string; blocks: Array<Record<string, unknown>>; usage: Record<string, unknown> | null }>
  subagentAssistantMessages: number
  toolUses: ToolUse[]
  toolResults: ToolResult[]
  subagentToolUses: ToolUse[]
  subagentToolResults: ToolResult[]
  assistantTexts: string[]
  injectedChars: number
  result: Record<string, unknown> | null
  init: Record<string, unknown> | null
  finalText: string
  exitCode: number | null
  stderr: string
  unparseable: number
  wallMs: number
  timedOut: boolean
  sessionId: string
}


export function parseEnvelopes(envelopes: Array<Record<string, unknown>>): Pick<RunRecord, 'assistantMessages' | 'subagentAssistantMessages' | 'toolUses' | 'toolResults' | 'subagentToolUses' | 'subagentToolResults' | 'assistantTexts' | 'injectedChars' | 'result' | 'init' | 'finalText'> {
  const assistantMessages: RunRecord['assistantMessages'] = []
  const toolUses: ToolUse[] = []
  const toolResults: ToolResult[] = []
  const subagentToolUses: ToolUse[] = []
  const subagentToolResults: ToolResult[] = []
  const assistantTexts: string[] = []
  const seenUses = new Set<string>()
  const seenResults = new Set<string>()
  const subagentMessages = new Set<string>()
  let result: Record<string, unknown> | null = null
  let init: Record<string, unknown> | null = null
  let lastAssistantText = ''
  const messageOf = (messageId: string): RunRecord['assistantMessages'][number] => {
    const existing = assistantMessages.find(m => m.messageId === messageId)
    if (existing) return existing
    const fresh = { messageId, blocks: [] as Array<Record<string, unknown>>, usage: null as Record<string, unknown> | null }
    assistantMessages.push(fresh)
    return fresh
  }
  envelopes.forEach((e, envelopeIndex) => {
    const type = e.type
    if (isSession(e)) init = e
    const parent = typeof e.parent_call_id === 'string' && e.parent_call_id ? e.parent_call_id : null
    const messageId = String(e.message_id ?? `row-${envelopeIndex}`)
    if (type === 'text' || type === 'reasoning' || type === 'tool_call') {
      if (parent) {
        subagentMessages.add(messageId)
      } else {
        const message = messageOf(messageId)
        const block = type === 'tool_call'
          ? { type: 'tool_use', id: e.call_id, name: e.tool, input: e.input }
          : type === 'text'
            ? { type: 'text', text: e.text }
            : { type: 'thinking', thinking: e.text }
        if (!message.blocks.some(b => JSON.stringify(b) === JSON.stringify(block))) message.blocks.push(block as Record<string, unknown>)
      }
      if (type === 'tool_call') {
        const id = String(e.call_id ?? '')
        if (!seenUses.has(id)) {
          seenUses.add(id)
          const use: ToolUse = { id, name: String(e.tool ?? ''), input: (e.input as Record<string, unknown>) ?? {}, messageId, parentToolUseId: parent }
          if (parent) subagentToolUses.push(use)
          else toolUses.push(use)
        }
      } else if (type === 'text' && typeof e.text === 'string' && e.text.trim() && !parent) {
        assistantTexts.push(e.text)
        lastAssistantText = e.text
      }
    }
    if (type === 'step' && !parent) {
      const message = messageOf(messageId)
      message.usage = (e.usage as Record<string, unknown>) ?? null
    }
    if (type === 'tool_result') {
      const id = String(e.call_id ?? '')
      if (!seenResults.has(`${parent ?? ''}:${id}`)) {
        seenResults.add(`${parent ?? ''}:${id}`)
        const text = typeof e.output === 'string' ? e.output : ''
        const row: ToolResult = { id, text, isError: e.status === 'error', imageChars: 0, parentToolUseId: parent }
        if (parent) subagentToolResults.push(row)
        else toolResults.push(row)
      }
    }
    if (isOutcome(e)) result = e
  })
  const resultText = result && typeof (result as Record<string, unknown>).answer === 'string' ? String((result as Record<string, unknown>).answer) : ''
  return { assistantMessages, subagentAssistantMessages: subagentMessages.size, toolUses, toolResults, subagentToolUses, subagentToolResults, assistantTexts, injectedChars: 0, result, init, finalText: resultText || lastAssistantText }
}

function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
    }
  }
}

export async function runHeadless(spec: RunSpec): Promise<RunRecord> {
  const args = [spec.dist, 'run', spec.prompt, '--format', 'rows', '--model', spec.model, '--mode', spec.permissionMode, '--max-turns', String(spec.maxTurns)]
  if (spec.allowedTools.length > 0) args.push('--allowed-tools', ...spec.allowedTools)
  if (spec.sessionId) args.push('--session-id', spec.sessionId)
  if (spec.resume) args.push('--resume', spec.resume)
  const startedAt = Date.now()
  const child = spawn(spec.nodeBin, args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  const envelopes: Array<Record<string, unknown>> = []
  let unparseable = 0
  let buf = ''
  let stderr = ''
  let timedOut = false
  child.stdout.on('data', d => {
    buf += String(d)
    for (;;) {
      const nl = buf.indexOf('\n')
      if (nl === -1) break
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      const frame = parseFrame(line)
      if (frame !== null) envelopes.push(frame)
      else unparseable++
    }
  })
  child.stderr.on('data', d => {
    stderr += String(d)
  })
  const deadline = setTimeout(() => {
    timedOut = true
    killTree(child.pid!, 'SIGTERM')
    setTimeout(() => killTree(child.pid!, 'SIGKILL'), 3_000).unref()
  }, spec.timeoutMs)
  const exitCode = await new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
  clearTimeout(deadline)
  if (buf.trim()) {
    const frame = parseFrame(buf)
    if (frame !== null) envelopes.push(frame)
    else unparseable++
  }
  const parsed = parseEnvelopes(envelopes)
  const sessionId = String((parsed.init as Record<string, unknown> | null)?.session_id ?? (parsed.result as Record<string, unknown> | null)?.session_id ?? spec.sessionId ?? '')
  return {
    spec,
    envelopes,
    ...parsed,
    exitCode,
    stderr,
    unparseable,
    wallMs: Date.now() - startedAt,
    timedOut,
    sessionId,
  }
}
