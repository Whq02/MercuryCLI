import { createHash } from 'node:crypto'
import { flagEnv } from '../../../substrate/flagRegistry.js'
import { logForDebugging } from '../../../utils/debug.js'

export interface WirePrefixParts {
  system: unknown
  tools: readonly unknown[]
  messages: readonly unknown[]
}

export interface PrefixMismatch {
  part: string
  path: string
  before?: string
  after?: string
}

export interface PrefixVerdict {
  mismatch: PrefixMismatch | null
  lastThinkingIndex: number
  compared: boolean
  key: string
  wireMessageIds: Array<string | null>
}

interface SystemBlockRecord {
  digest: string
  text: string
  sections: Array<{ heading: string; at: number }>
}

interface ToolRecord {
  name: string
  deferred: boolean
  description: string
  schema: string
  bound: boolean
}

interface MessageRecord {
  role: string
  digest: string
  blocks: Array<{ kind: string; digest: string }>
}

interface PrefixRecord {
  key: string
  whole: string
  system: SystemBlockRecord[]
  tools: ToolRecord[]
  messages: MessageRecord[]
  wireMessageIds: Array<string | null>
}

const j = (v: unknown): string => JSON.stringify(v)
const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

export function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'cache_control') continue
      out[k] = withoutCacheControl(v)
    }
    return out
  }
  return value
}

const isThinkingBlock = (block: unknown): boolean => {
  const type = (block as { type?: unknown } | null)?.type
  return type === 'thinking' || type === 'redacted_thinking'
}

function systemBlocksOf(system: unknown): Array<{ text: string }> {
  if (typeof system === 'string') return [{ text: system }]
  if (!Array.isArray(system)) return []
  return system.map(block => ({ text: String((block as { text?: unknown } | null)?.text ?? '') }))
}

function sectionsOf(text: string): Array<{ heading: string; at: number }> {
  const out: Array<{ heading: string; at: number }> = []
  const re = /^# (.+)$/gm
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) out.push({ heading: match[1]!.trim(), at: match.index })
  return out
}

export function referencedToolNames(messages: readonly unknown[]): Set<string> {
  const names = new Set<string>()
  for (const message of messages) {
    const content = (message as { content?: unknown } | null)?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const b = block as { type?: string; name?: unknown; tool_name?: unknown; content?: unknown }
      if (b.type === 'tool_use' && typeof b.name === 'string') names.add(b.name)
      if (b.type === 'tool_reference' && typeof b.tool_name === 'string') names.add(b.tool_name)
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        for (const inner of b.content) {
          const r = inner as { type?: string; tool_name?: unknown }
          if (r.type === 'tool_reference' && typeof r.tool_name === 'string') names.add(r.tool_name)
        }
      }
    }
  }
  return names
}

export function boundTools(tools: readonly unknown[], messages: readonly unknown[]): unknown[] {
  const referenced = referencedToolNames(messages)
  return tools.filter(tool => {
    const t = tool as { name?: unknown; defer_loading?: unknown }
    return t.defer_loading !== true || (typeof t.name === 'string' && referenced.has(t.name))
  })
}

function blockKind(block: unknown): string {
  const b = block as { type?: string; text?: unknown } | null
  if (b === null || typeof b !== 'object') return typeof block
  if (b.type === 'text') {
    const text = typeof b.text === 'string' ? b.text : ''
    if (text.startsWith('<system-reminder>')) return 'system-reminder'
    if (text.startsWith('<available-deferred-tools>')) return 'deferred-tools announcement'
    return 'text'
  }
  return b.type ?? 'block'
}

function recordOf(key: string, parts: WirePrefixParts): PrefixRecord {
  const referenced = referencedToolNames(parts.messages)
  const system = systemBlocksOf(parts.system).map(block => ({
    digest: sha(block.text),
    text: block.text,
    sections: sectionsOf(block.text),
  }))
  const tools = parts.tools.map(tool => {
    const t = withoutCacheControl(tool) as { name?: unknown; defer_loading?: unknown; description?: unknown; input_schema?: unknown }
    const name = typeof t.name === 'string' ? t.name : '?'
    const deferred = t.defer_loading === true
    return {
      name,
      deferred,
      description: sha(String(t.description ?? '')),
      schema: sha(j(t.input_schema ?? null)),
      bound: !deferred || referenced.has(name),
    }
  })
  const messages = parts.messages.map(message => {
    const m = withoutCacheControl(message) as { role?: unknown; content?: unknown }
    const content = Array.isArray(m.content) ? m.content.filter(block => !isThinkingBlock(block)) : m.content
    const blocks = Array.isArray(content)
      ? content.map(block => ({ kind: blockKind(block), digest: sha(j(block)) }))
      : [{ kind: typeof content === 'string' ? 'text' : 'content', digest: sha(j(content)) }]
    return { role: String(m.role ?? '?'), digest: sha(j({ role: m.role, content })), blocks }
  })
  const whole = sha(j({ system: system.map(s => s.digest), tools: tools.map(t => `${t.name}|${t.deferred}|${t.description}|${t.schema}`), messages: messages.map(m => m.digest) }))
  return { key, whole, system, tools, messages, wireMessageIds: [] }
}

export function lastThinkingMessageIndex(messages: readonly unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const content = (messages[index] as { content?: unknown } | null)?.content
    if (Array.isArray(content) && content.some(isThinkingBlock)) return index
  }
  return -1
}

function excerpt(text: string, at: number): string {
  const start = Math.max(0, at - 60)
  return `${start > 0 ? '…' : ''}${text.slice(start, at + 100)}${at + 100 < text.length ? '…' : ''}`
}

function firstDiffAt(a: string, b: string): number {
  let at = 0
  while (at < a.length && at < b.length && a[at] === b[at]) at++
  return at
}

const ordinal = (index: number): string => `turn ${index}`

function compareRecords(previous: PrefixRecord, current: PrefixRecord, lastThinkingIndex: number): PrefixMismatch | null {
  const blocks = Math.max(previous.system.length, current.system.length)
  for (let b = 0; b < blocks; b++) {
    const was = previous.system[b]
    const now = current.system[b]
    if (was === undefined) return { part: `the system prompt (block ${b} added)`, path: `system[${b}] (added)`, after: excerpt(now!.text, 0) }
    if (now === undefined) return { part: `the system prompt (block ${b} removed)`, path: `system[${b}] (removed)`, before: excerpt(was.text, 0) }
    if (was.digest === now.digest) continue
    const at = firstDiffAt(was.text, now.text)
    const section = [...was.sections].reverse().find(s => s.at <= at) ?? [...now.sections].reverse().find(s => s.at <= at)
    const name = section === undefined ? `the system prompt (block ${b})` : `the system prompt's ${section.heading} section`
    return { part: name, path: `system[${b}].text@char ${at}`, before: excerpt(was.text, at), after: excerpt(now.text, at) }
  }
  const wasByName = new Map(previous.tools.map(t => [t.name, t] as const))
  const nowByName = new Map(current.tools.map(t => [t.name, t] as const))
  const wasBound = previous.tools.filter(t => t.bound)
  const nowBound = current.tools.filter(t => t.bound)
  const added = nowBound.filter(t => !wasByName.has(t.name)).map(t => t.name)
  const removed = wasBound.filter(t => nowByName.get(t.name)?.bound !== true).map(t => t.name)
  if (added.length > 0 || removed.length > 0) {
    const words: string[] = []
    if (added.length > 0) words.push(`${added.length} added (${added.join(', ')})`)
    if (removed.length > 0) words.push(`${removed.length} removed (${removed.join(', ')})`)
    return { part: `the tools set: ${words.join(', ')}`, path: `tools.length (${wasBound.length} → ${nowBound.length})` }
  }
  const wasBoth = wasBound.filter(t => nowByName.get(t.name)?.bound === true)
  const nowBoth = nowBound.filter(t => wasByName.get(t.name)?.bound === true)
  for (let i = 0; i < wasBoth.length; i++) {
    const was = wasBoth[i]!
    const now = nowBoth[i]
    if (now === undefined || was.name !== now.name) return { part: `the tools set: reordered (${was.name} → ${now?.name ?? 'nothing'} at position ${i})`, path: `tools[${i}].name` }
    if (was.deferred !== now.deferred) return { part: `the tool ${was.name}'s deferral mark`, path: `tools[${i}].defer_loading` }
    if (was.description !== now.description) return { part: `the tool ${was.name}'s description`, path: `tools[${i}].description` }
    if (was.schema !== now.schema) return { part: `the tool ${was.name}'s input schema`, path: `tools[${i}].input_schema` }
  }
  const range = Math.min(lastThinkingIndex, previous.messages.length)
  for (let k = 0; k < range; k++) {
    const was = previous.messages[k]!
    const now = current.messages[k]
    if (now === undefined) return { part: `${ordinal(k)} (the history shrank)`, path: `messages.length (${previous.messages.length} → ${current.messages.length})` }
    if (was.digest === now.digest) continue
    if (was.role !== now.role) return { part: `${ordinal(k)}'s role (${was.role} → ${now.role})`, path: `messages[${k}].role` }
    const n = Math.max(was.blocks.length, now.blocks.length)
    for (let i = 0; i < n; i++) {
      const wb = was.blocks[i]
      const nb = now.blocks[i]
      if (wb === undefined) return { part: `${ordinal(k)}'s ${was.role} row: ${nb!.kind} block ${i} added`, path: `messages[${k}].content[${i}] (added)` }
      if (nb === undefined) return { part: `${ordinal(k)}'s ${was.role} row: ${wb.kind} block ${i} removed`, path: `messages[${k}].content[${i}] (removed)` }
      if (wb.digest !== nb.digest) {
        const kind = wb.kind === nb.kind ? wb.kind : `${wb.kind} → ${nb.kind}`
        return { part: `${ordinal(k)}'s ${was.role} row: ${kind} block ${i}`, path: `messages[${k}].content[${i}]` }
      }
    }
    return { part: `${ordinal(k)}'s ${was.role} row`, path: `messages[${k}]` }
  }
  return null
}

const records = new Map<string, PrefixRecord>()
const verdicts = new Map<string, PrefixVerdict>()

export function resetPrefixLedger(): void {
  records.clear()
  verdicts.clear()
}

export function prefixRecordFor(owner: string): { key: string; whole: string; systemDigests: string[]; toolNames: string[]; messageDigests: string[] } | null {
  const record = records.get(owner)
  if (record === undefined) return null
  return { key: record.key, whole: record.whole, systemDigests: record.system.map(s => s.digest), toolNames: record.tools.map(t => `${t.name}${t.deferred ? '+' : ''}${t.bound ? '' : '?'}`), messageDigests: record.messages.map(m => m.digest) }
}

export function judgeAndRecordPrefix(
  owner: string,
  key: string,
  parts: WirePrefixParts,
  wireMessageIds: ReadonlyArray<string | null> = [],
  opts?: { replaceRecord?: boolean },
): PrefixVerdict {
  const replace = opts?.replaceRecord !== false
  const current = recordOf(key, parts)
  current.wireMessageIds = [...wireMessageIds]
  const previous = records.get(owner)
  if (previous !== undefined && previous.key === key && previous.whole === current.whole) {
    if (replace) records.set(owner, current)
    return verdicts.get(owner) ?? { mismatch: null, lastThinkingIndex: lastThinkingMessageIndex(parts.messages), compared: true, key, wireMessageIds: current.wireMessageIds }
  }
  const lastThinkingIndex = lastThinkingMessageIndex(parts.messages)
  let mismatch: PrefixMismatch | null = null
  const compared = previous !== undefined && previous.key === key
  if (compared && lastThinkingIndex >= 0) {
    mismatch = compareRecords(previous, current, lastThinkingIndex)
    if (mismatch !== null) {
      logForDebugging(`preserved thinking: the prefix ledger names a rewrite of sent history before the request went out — ${mismatch.part} (${mismatch.path})${mismatch.before !== undefined ? `; before: ${j(mismatch.before)}; after: ${j(mismatch.after ?? '')}` : ''}`, { level: 'warn' })
    }
  }
  const verdict: PrefixVerdict = { mismatch, lastThinkingIndex, compared, key, wireMessageIds: current.wireMessageIds }
  if (replace) {
    records.set(owner, current)
    verdicts.set(owner, verdict)
  }
  return verdict
}

export function takePrefixVerdict(owner: string): PrefixVerdict | null {
  const verdict = verdicts.get(owner)
  if (verdict === undefined) return null
  verdicts.delete(owner)
  return verdict
}

export function pendingPrefixVerdict(owner: string): PrefixVerdict | null {
  return verdicts.get(owner) ?? null
}

export function describePrefixMismatch(mismatch: PrefixMismatch): string {
  return `Mercury's prefix ledger names the part that moved: ${mismatch.part} (${mismatch.path}).`
}


export type InducedPrefixEdit = { kind: 'system' } | { kind: 'tools' } | { kind: 'turn'; index: number }

export function resolveInducedPrefixEdit(raw: string | undefined = flagEnv('MERCURY_PREFIX_INDUCE_EDIT')): InducedPrefixEdit | null {
  if (raw === undefined) return null
  const value = raw.trim().toLowerCase()
  if (value === '') return null
  if (value === 'system') return { kind: 'system' }
  if (value === 'tools') return { kind: 'tools' }
  const turn = /^turn:(\d+)$/.exec(value)
  if (turn !== null) return { kind: 'turn', index: Number(turn[1]) }
  logForDebugging(`MERCURY_PREFIX_INDUCE_EDIT=${raw}: not a known value (system · tools · turn:N) — no edit induced`, { level: 'warn' })
  return null
}

export function inducedEditApplies(messages: readonly { type?: string }[]): boolean {
  return messages.some(message => message.type === 'assistant')
}

export function applyInducedPrefixEdit(parts: WirePrefixParts, edit: InducedPrefixEdit): WirePrefixParts {
  if (edit.kind === 'system') {
    if (typeof parts.system === 'string') return { ...parts, system: `${parts.system}\n\n[induced edit]` }
    if (!Array.isArray(parts.system) || parts.system.length === 0) return parts
    const blocks = [...(parts.system as Array<Record<string, unknown>>)]
    const last = blocks[blocks.length - 1]!
    blocks[blocks.length - 1] = { ...last, text: `${String(last.text ?? '')}\n\n[induced edit]` }
    return { ...parts, system: blocks }
  }
  if (edit.kind === 'tools') {
    if (parts.tools.length === 0) return parts
    return { ...parts, tools: parts.tools.slice(0, -1) }
  }
  const target = parts.messages[edit.index] as { role?: unknown; content?: unknown } | undefined
  if (target === undefined) return parts
  const content = Array.isArray(target.content) ? [...target.content, { type: 'text', text: '[induced edit]' }] : [{ type: 'text', text: String(target.content ?? '') }, { type: 'text', text: '[induced edit]' }]
  const messages = [...parts.messages]
  messages[edit.index] = { ...target, content }
  return { ...parts, messages }
}
