// ============================================================================
//  scripts/agent-experience/lib/runner.ts — one headless Mercury run.
//
//  Spawns `node dist/mercury.mjs -p --verbose --output-format stream-json`
//  in the scratch project with the family's env, collects every stdout
//  envelope, and reads the transcript back into the shape the scorer and
//  the oracles consume: assistant turns, tool uses, tool results, the
//  result envelope, the final text. The child runs in its own process group
//  and the whole group is killed on the deadline (children first).
// ============================================================================
import { spawn } from 'node:child_process'

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
  /** The provider message id (stream-json emits one envelope per content
   *  block, all carrying the same message id — a parallel round is one id). */
  messageId: string
  /** Set when a subagent (not the main thread) made the call. */
  parentToolUseId: string | null
}

export interface ToolResult {
  id: string
  text: string
  isError: boolean
  /** Base64 payload length of image blocks (counted apart from text). */
  imageChars: number
  parentToolUseId: string | null
}

export interface RunRecord {
  spec: RunSpec
  envelopes: Array<Record<string, unknown>>
  /** MAIN-THREAD assistant messages, one per provider message id, in order
   *  (subagent traffic — envelopes carrying parent_tool_use_id — is kept in
   *  subagentAssistantMessages). */
  assistantMessages: Array<{ messageId: string; blocks: Array<Record<string, unknown>>; usage: Record<string, unknown> | null }>
  subagentAssistantMessages: number
  /** Main-thread tool uses/results; subagent ones ride the sibling lists. */
  toolUses: ToolUse[]
  toolResults: ToolResult[]
  subagentToolUses: ToolUse[]
  subagentToolResults: ToolResult[]
  /** Main-thread assistant TEXT blocks in order (a dialect may report a
   *  malformed provider call as assistant text rather than a tool result). */
  assistantTexts: string[]
  /** Text INJECTED into the main thread as user messages that are not tool
   *  results — skill expansions, reminders, task notifications: read by
   *  the model like a tool result, but invisible to a tool-result count. */
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

function textOfResult(content: unknown): { text: string; imageChars: number } {
  if (typeof content === 'string') return { text: content, imageChars: 0 }
  if (!Array.isArray(content)) return { text: content == null ? '' : JSON.stringify(content), imageChars: 0 }
  let text = ''
  let imageChars = 0
  for (const block of content as Array<Record<string, any>>) {
    if (!block) continue
    if (block.type === 'text' && typeof block.text === 'string') text += (text ? '\n' : '') + block.text
    else if (block.type === 'image') imageChars += String(block.source?.data ?? '').length
    else text += (text ? '\n' : '') + JSON.stringify(block)
  }
  return { text, imageChars }
}

export function parseEnvelopes(envelopes: Array<Record<string, unknown>>): Pick<RunRecord, 'assistantMessages' | 'subagentAssistantMessages' | 'toolUses' | 'toolResults' | 'subagentToolUses' | 'subagentToolResults' | 'assistantTexts' | 'injectedChars' | 'result' | 'init' | 'finalText'> {
  const assistantMessages: RunRecord['assistantMessages'] = []
  const toolUses: ToolUse[] = []
  const toolResults: ToolResult[] = []
  const subagentToolUses: ToolUse[] = []
  const subagentToolResults: ToolResult[] = []
  const assistantTexts: string[] = []
  let injectedChars = 0
  const seenUses = new Set<string>()
  const seenResults = new Set<string>()
  let subagentAssistantMessages = 0
  let result: Record<string, unknown> | null = null
  let init: Record<string, unknown> | null = null
  let lastAssistantText = ''
  envelopes.forEach((e, envelopeIndex) => {
    const type = e.type
    if (type === 'system' && e.subtype === 'init') init = e
    const parent = typeof e.parent_tool_use_id === 'string' && e.parent_tool_use_id ? e.parent_tool_use_id : null
    if (type === 'assistant') {
      const message = e.message as { id?: unknown; content?: unknown; usage?: Record<string, unknown> } | undefined
      // The provider message id groups the blocks of one round; an envelope
      // without one stands alone (never merged into a neighbour).
      const messageId = String(message?.id ?? e.uuid ?? `envelope-${envelopeIndex}`)
      const blocks = Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>) : []
      if (parent) {
        subagentAssistantMessages++
      } else {
        const existing = assistantMessages.find(m => m.messageId === messageId)
        if (existing) {
          for (const block of blocks) if (!existing.blocks.includes(block)) existing.blocks.push(block)
        } else {
          assistantMessages.push({ messageId, blocks: [...blocks], usage: message?.usage ?? null })
        }
      }
      for (const block of blocks) {
        if (block.type === 'tool_use') {
          const id = String(block.id ?? '')
          // One envelope per block, each repeating the earlier blocks of the
          // same message on some dialects — dedupe by tool-use id.
          if (seenUses.has(id)) continue
          seenUses.add(id)
          const use: ToolUse = { id, name: String(block.name ?? ''), input: (block.input as Record<string, unknown>) ?? {}, messageId, parentToolUseId: parent }
          if (parent) subagentToolUses.push(use)
          else toolUses.push(use)
        } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          if (!parent) {
            assistantTexts.push(block.text)
            lastAssistantText = block.text
          }
        }
      }
    }
    if (type === 'user') {
      const message = e.message as { content?: unknown } | undefined
      const content = message?.content
      // The user's own prompt is replayed only on request (isReplay); every
      // other main-thread user text is harness-injected.
      if (!parent && e.isReplay !== true) {
        if (typeof content === 'string') injectedChars += content.length
        else if (Array.isArray(content)) for (const block of content as Array<Record<string, unknown>>) if (block.type === 'text' && typeof block.text === 'string') injectedChars += block.text.length
      }
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'tool_result') {
            const id = String(block.tool_use_id ?? '')
            if (seenResults.has(`${parent ?? ''}:${id}`)) continue
            seenResults.add(`${parent ?? ''}:${id}`)
            const { text, imageChars } = textOfResult(block.content)
            const row: ToolResult = { id, text, isError: block.is_error === true, imageChars, parentToolUseId: parent }
            if (parent) subagentToolResults.push(row)
            else toolResults.push(row)
          }
        }
      }
    }
    if (type === 'result') result = e
  })
  const resultText = result && typeof (result as Record<string, unknown>).result === 'string' ? String((result as Record<string, unknown>).result) : ''
  return { assistantMessages, subagentAssistantMessages, toolUses, toolResults, subagentToolUses, subagentToolResults, assistantTexts, injectedChars, result, init, finalText: resultText || lastAssistantText }
}

function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      /* already gone */
    }
  }
}

export async function runHeadless(spec: RunSpec): Promise<RunRecord> {
  const args = [spec.dist, '-p', '--verbose', '--output-format', 'stream-json', '--model', spec.model, '--permission-mode', spec.permissionMode, '--max-turns', String(spec.maxTurns)]
  if (spec.allowedTools.length > 0) args.push('--allowedTools', ...spec.allowedTools)
  if (spec.sessionId) args.push('--session-id', spec.sessionId)
  if (spec.resume) args.push('--resume', spec.resume)
  args.push(spec.prompt)
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
      try {
        envelopes.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        unparseable++
      }
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
    try {
      envelopes.push(JSON.parse(buf) as Record<string, unknown>)
    } catch {
      unparseable++
    }
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
