import type { RunRecord } from './runner.ts'

export interface ErrorRow {
  tool: string
  text: string
  namesFix: boolean
  probe: boolean
}

export interface Score {
  success: boolean | null
  oracle: string
  turns: number
  toolCalls: number
  wasted: number
  probes: number
  unexpectedErrors: number
  duplicates: number
  toolResultChars: number
  toolResultTokensEst: number
  imageChars: number
  injectedTokensEst: number
  subagentResultTokensEst: number
  asks: number
  denials: number
  errors: ErrorRow[]
  wallMs: number
  exitCode: number | null
  timedOut: boolean
  resultSubtype: string
  usage: Record<string, unknown> | null
  costUsd: number | null
}

const ASK_RE = /permission (for this action )?has been denied|requires (explicit )?(user )?(approval|confirmation)|doesn't want to (proceed|take this action)|the user declined|denied automatically|needs (your|user) approval/i

const REFUSAL_NOTE_RE = /the provider emitted a malformed tool call|refused by the harness before execution|was not executed/i

const FIX_RE = /\b(old_string|new_string|pattern|url|file_path|filePath|operation|required|expected|accepted|available|must (be|contain|name)|instead|try |use |read (it|the file)|nearest|did you mean|exactly one of|valid (values|options)|one of)\b/i

export function scoreRun(run: RunRecord, verdict: { pass: boolean | null; detail: string }, probeSteps: Array<{ tool: string; probe: boolean }>): Score {
  const result = run.result ?? null
  const numTurns = typeof result?.num_turns === 'number' ? (result.num_turns as number) : run.assistantMessages.length
  const errors: ErrorRow[] = []
  const usesById = new Map(run.toolUses.map(u => [u.id, u]))
  let probesSeen = 0
  const probeQueue = probeSteps.filter(p => p.probe)
  const pushError = (tool: string, text: string): void => {
    const next = probeQueue[probesSeen]
    const probe = next !== undefined && next.tool === tool
    if (probe) probesSeen++
    errors.push({ tool, text: text.slice(0, 600), namesFix: text.length > 24 && FIX_RE.test(text), probe })
  }
  const ordered: Array<{ at: number; tool: string; text: string }> = []
  const resultIndex = new Map<string, number>()
  run.envelopes.forEach((e, i) => {
    if (e.type === 'user' && !e.parent_tool_use_id) {
      const content = (e.message as { content?: unknown } | undefined)?.content
      if (Array.isArray(content)) for (const b of content as Array<Record<string, unknown>>) if (b.type === 'tool_result') resultIndex.set(String(b.tool_use_id ?? ''), i)
    }
    if (e.type === 'assistant' && !e.parent_tool_use_id) {
      const content = (e.message as { content?: unknown } | undefined)?.content
      if (Array.isArray(content)) {
        for (const b of content as Array<Record<string, unknown>>) {
          if (b.type === 'text' && typeof b.text === 'string' && REFUSAL_NOTE_RE.test(b.text)) {
            const tool = /malformed tool call \(([^)]+)\)|unknown tool \(([^)]+)\)|catalog \(([^)]+)\)|tool call \(([^)]+)\)/i.exec(b.text)
            const name = tool?.[1] ?? tool?.[2] ?? tool?.[3] ?? tool?.[4] ?? '?'
            if (!ordered.some(o => o.text === b.text)) ordered.push({ at: i, tool: name, text: b.text })
          }
        }
      }
    }
  })
  for (const r of run.toolResults) {
    if (!r.isError) continue
    ordered.push({ at: resultIndex.get(r.id) ?? Number.MAX_SAFE_INTEGER, tool: usesById.get(r.id)?.name ?? '?', text: r.text })
  }
  ordered.sort((a, b) => a.at - b.at)
  for (const o of ordered) pushError(o.tool, o.text)
  const seen = new Map<string, number>()
  let duplicates = 0
  for (const u of run.toolUses) {
    const key = `${u.name}:${JSON.stringify(u.input)}`
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    if (n > 1) duplicates++
  }
  let toolResultChars = 0
  let imageChars = 0
  for (const r of run.toolResults) {
    toolResultChars += r.text.length
    imageChars += r.imageChars
  }
  const denials = Array.isArray(result?.permission_denials) ? (result!.permission_denials as unknown[]).length : 0
  let askResults = 0
  for (const r of run.toolResults) if (ASK_RE.test(r.text)) askResults++
  const probes = probeSteps.filter(p => p.probe).length
  const wasted = errors.length + duplicates
  return {
    success: verdict.pass,
    oracle: verdict.detail,
    turns: numTurns,
    toolCalls: run.toolUses.length,
    wasted,
    probes,
    unexpectedErrors: Math.max(0, errors.filter(e => !e.probe).length + duplicates),
    duplicates,
    toolResultChars,
    toolResultTokensEst: Math.round(toolResultChars / 4),
    imageChars,
    injectedTokensEst: Math.round(run.injectedChars / 4),
    subagentResultTokensEst: Math.round(run.subagentToolResults.reduce((a, r) => a + r.text.length, 0) / 4),
    asks: denials + askResults,
    denials,
    errors,
    wallMs: run.wallMs,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    resultSubtype: String(result?.subtype ?? (run.timedOut ? 'timeout' : 'no-result')),
    usage: (result?.usage as Record<string, unknown>) ?? null,
    costUsd: typeof result?.total_cost_usd === 'number' ? (result.total_cost_usd as number) : null,
  }
}
