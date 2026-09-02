// ============================================================================
//  resources/adapters/transcript — mercury://transcript/*: bounded, concise
//  transcript views as refs.
//
//    mercury://transcript/session/<sid>          — a concise, pageable view
//      of one session's turns: the fabric mirror (readSessionRoomTurns)
//      first, the transcript JSONL as fallback (older sessions; includes
//      tool-use one-liners the mirror doesn't carry)
//    mercury://transcript/agent/<sid>/<stem>     — a finished subagent
//      execution's transcript (the child JSONL), same concise row grammar
//
//  Bounded + dereferenceable: rows are one-liners; q/cursor/limit ride the
//  shared boundedTextView. absent (unknown sid) ≠ unavailable (storage
//  layer failed) stays distinct. Read-only by construction.
// ============================================================================

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { registerResourceAdapter } from '../registry.js'
import { boundedTextView, type ResourceAdapter, type ResourceChild } from '../contracts.js'
import { parseOwnerKey } from '../../primitives/owner.js'
import { projectIntelEnabled } from '../../projectIntel/contracts.js'

const SID_RE = /^[0-9a-f-]{8,64}$/i
const STEM_RE = /^[A-Za-z0-9._-]{1,80}$/
const MAX_ROWS = 2000
const SAMPLE = 140

function transcriptPathFor(sessionId: string): string | null {
  try {
    const { getTranscriptPathForSession } =
      require('../../../utils/sessionStorage/paths.js') as typeof import('../../../utils/sessionStorage/paths.js')
    return getTranscriptPathForSession(sessionId)
  } catch {
    return null
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, SAMPLE)
}

/** Concise rows from a transcript JSONL (session or subagent). */
export function jsonlConciseRows(file: string): string[] {
  const rows: string[] = []
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return rows
  }
  for (const line of raw.split('\n')) {
    if (rows.length >= MAX_ROWS) {
      rows.push(`… capped at ${MAX_ROWS} rows`)
      break
    }
    if (!line.trim().startsWith('{')) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const type = entry.type
    if (type !== 'user' && type !== 'assistant') continue
    const message = entry.message as Record<string, unknown> | undefined
    const content = message?.content
    if (typeof content === 'string') {
      if (content.trim()) rows.push(`${type}: ${oneLine(content)}`)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        rows.push(`${type}: ${oneLine(block.text)}`)
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const input = (block.input ?? {}) as Record<string, unknown>
        const target =
          typeof input.file_path === 'string'
            ? input.file_path
            : typeof input.pattern === 'string'
              ? `/${input.pattern}/`
              : typeof input.command === 'string'
                ? oneLine(input.command).slice(0, 60)
                : ''
        rows.push(`${type}: → ${block.name}${target ? ` ${target}` : ''}`)
      } else if (block.type === 'tool_result') {
        // Content is a string OR an array of text blocks (the common JSONL
        // shape — audit: string-only left tool rows nearly absent).
        const raw = block.content
        const text =
          typeof raw === 'string'
            ? raw
            : Array.isArray(raw)
              ? (raw as Array<{ type?: string; text?: string }>)
                  .map(b => (typeof b.text === 'string' ? b.text : ''))
                  .join(' ')
              : ''
        if (text.trim()) rows.push(`tool: ${oneLine(text)}`)
      }
    }
  }
  return rows
}

async function sessionRows(sessionId: string): Promise<{ rows: string[]; source: string } | null> {
  const file = transcriptPathFor(sessionId)
  if (!file || !existsSync(file)) return null
  const rows = jsonlConciseRows(file)
  return rows.length > 0 ? { rows, source: 'transcript JSONL' } : null
}

export const transcriptAdapter: ResourceAdapter = {
  kind: 'transcript',
  describe: 'bounded concise transcript views (session/<sid> · agent/<sid>/<stem>)',
  async resolve(ref, _ctx) {
    if (!projectIntelEnabled()) {
      return { state: 'unavailable', note: 'project intelligence is disabled (MERCURY_PROJECT_INTEL=0)' }
    }
    const parts = ref.id.split('/')
    const sub = parts[0]

    if (sub === 'session') {
      const sid = parts[1] ?? ''
      if (!SID_RE.test(sid)) {
        return { state: 'absent', note: `bad session id '${sid}' — mercury://transcript/session/<session-uuid>` }
      }
      const result = await sessionRows(sid)
      if (!result) {
        return { state: 'absent', note: `no transcript found for session '${sid}' (unknown sid, or nothing recorded)` }
      }
      const view = boundedTextView(result.rows.join('\n'), ref.selectors, 100)
      return {
        state: 'ok',
        resource: {
          ref: `mercury://transcript/session/${sid}`,
          kind: 'transcript',
          title: `session ${sid.slice(0, 8)} — concise transcript`,
          summary: `${result.rows.length} row(s) · source: ${result.source}`,
          mutable: true,
          text: view.text,
          page: view.page,
        },
      }
    }

    if (sub === 'agent') {
      const sid = parts[1] ?? ''
      const stem = parts.slice(2).join('/')
      if (!SID_RE.test(sid) || !STEM_RE.test(stem)) {
        return { state: 'absent', note: 'bad agent transcript ref — mercury://transcript/agent/<session-uuid>/<agent-file-stem>' }
      }
      const sessionFile = transcriptPathFor(sid)
      if (!sessionFile) {
        return { state: 'unavailable', note: 'session storage paths unavailable in this process' }
      }
      const agentFile = join(dirname(sessionFile), sid, 'subagents', `${stem}.jsonl`)
      if (!existsSync(agentFile)) {
        return { state: 'absent', note: `no subagent transcript '${stem}' under session '${sid.slice(0, 8)}'` }
      }
      const rows = jsonlConciseRows(agentFile)
      const view = boundedTextView(rows.join('\n'), ref.selectors, 100)
      return {
        state: 'ok',
        resource: {
          ref: `mercury://transcript/agent/${sid}/${stem}`,
          kind: 'transcript',
          title: `subagent ${stem} — concise transcript`,
          summary: `${rows.length} row(s) · finished agent execution`,
          mutable: false,
          text: view.text,
          page: view.page,
        },
      }
    }

    return {
      state: 'absent',
      note: `unknown transcript form '${ref.id}' — use session/<sid> or agent/<sid>/<stem>`,
    }
  },
  async list(ctx) {
    // The CURRENT session's reachable transcripts: itself + its subagents.
    const children: ResourceChild[] = []
    if (!projectIntelEnabled()) return children
    try {
      const sid = parseOwnerKey(ctx.owner).sessionId
      if (!sid || sid.startsWith('@')) return children
      children.push({
        ref: `mercury://transcript/session/${sid}`,
        title: `session ${sid.slice(0, 8)}`,
        summary: 'this session (concise rows)',
      })
      const sessionFile = transcriptPathFor(sid)
      if (sessionFile) {
        const subagentsDir = join(dirname(sessionFile), sid, 'subagents')
        if (existsSync(subagentsDir)) {
          for (const f of readdirSync(subagentsDir).sort()) {
            if (!f.endsWith('.jsonl')) continue
            const stem = f.slice(0, -6)
            children.push({
              ref: `mercury://transcript/agent/${sid}/${stem}`,
              title: stem,
              summary: 'subagent execution',
            })
          }
        }
      }
    } catch {
      /* empty listing on storage failure — resolve() names states precisely */
    }
    return children
  },
}

registerResourceAdapter(transcriptAdapter)
