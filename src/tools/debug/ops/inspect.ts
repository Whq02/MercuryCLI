import { type DapSession, knownAdapterKeys, listDapSessions } from '../../../integrations/debugger/dapClient.js'
import type { OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import type { Input, InputWith, OpResult } from './schema.js'

export async function threadsOp(r: { root: DapSession; target: DapSession }): Promise<OpResult> {
  const body = await r.target.request('threads')
  const threads = Array.isArray(body.threads)
    ? (body.threads as Array<{ id?: number; name?: string }>)
    : []
  return {
    result: threads.length
      ? threads.map(t => `thread ${t.id}: ${t.name ?? '?'}`).join('\n')
      : '(no threads)',
    outcome: 'no-change',
  }
}

export async function scopesOp(r: { root: DapSession; target: DapSession }, input: Input): Promise<OpResult> {
  const body = await r.target.request('scopes', { frameId: input.frameId })
  const scopes = Array.isArray(body.scopes)
    ? (body.scopes as Array<{ name?: string; variablesReference?: number }>)
    : []
  return {
    result: scopes.length
      ? scopes
          .map(s => `${s.name ?? '?'} [variablesReference ${s.variablesReference ?? '?'}]`)
          .join('\n')
      : '(no scopes)',
    outcome: 'no-change',
  }
}

export async function variablesOp(r: { root: DapSession; target: DapSession }, input: Input): Promise<OpResult> {
  const body = await r.target.request('variables', {
    variablesReference: input.variablesReference,
  })
  const vars = Array.isArray(body.variables)
    ? (body.variables as Array<{
        name?: string
        value?: string
        type?: string
        variablesReference?: number
        memoryReference?: string
      }>)
    : []
  return {
    result: vars.length
      ? vars
          .map(
            v =>
              `${v.name ?? '?'} = ${v.value ?? '?'}` +
              (v.type ? ` (${v.type})` : '') +
              (v.variablesReference ? ` [ref ${v.variablesReference}]` : '') +
              (v.memoryReference ? ` [memory ${v.memoryReference}]` : ''),
          )
          .join('\n')
      : '(no variables)',
    outcome: 'no-change',
  }
}

export async function evaluateOp(r: { root: DapSession; target: DapSession }, input: Input, context: NonNullable<Input['context']>, frameId: number): Promise<OpResult> {
  const body = await r.target.request('evaluate', {
    expression: input.expression,
    frameId,
    context,
  })
  const debuggee = r.root.treeTerminated()
    ? ('terminated' as const)
    : r.root.treeStopped()
      ? ('stopped' as const)
      : ('running' as const)
  const variablesReference =
    typeof body.variablesReference === 'number' && body.variablesReference > 0 ? body.variablesReference : 0
  const namedVariables = typeof body.namedVariables === 'number' ? body.namedVariables : undefined
  const indexedVariables = typeof body.indexedVariables === 'number' ? body.indexedVariables : undefined
  const counts = [
    ...(namedVariables !== undefined ? [`${namedVariables} named`] : []),
    ...(indexedVariables !== undefined ? [`${indexedVariables} indexed`] : []),
  ].join(', ')
  const type = typeof body.type === 'string' && body.type ? body.type : undefined
  return {
    result:
      `${input.expression} = ${String(body.result ?? '?')}${type ? ` (${type})` : ''}` +
      (variablesReference ? ` [variablesReference ${variablesReference}${counts ? `, ${counts}` : ''}]` : '') +
      ` [debuggee ${debuggee}]`,
    outcome: 'succeeded',
    debuggee,
    details: {
      context,
      frameId,
      ...(variablesReference ? { variablesReference } : {}),
      ...(namedVariables !== undefined ? { namedVariables } : {}),
      ...(indexedVariables !== undefined ? { indexedVariables } : {}),
      ...(type ? { type } : {}),
      ...(typeof body.memoryReference === 'string' ? { memoryReference: body.memoryReference } : {}),
    },
  }
}

export function outputOp(r: { session: DapSession }): OpResult {
  const drained = r.session.output.splice(0, r.session.output.length)
  return {
    result: drained.length ? drained.join('\n') : '(no buffered output)',
    outcome: 'no-change',
  }
}

export function statusOp(owner: OwnerKey): OpResult {
  const all = listDapSessions(owner)
  if (all.length === 0) {
    return {
      result: `no debug sessions. adapters: ${knownAdapterKeys().join(', ')}`,
      outcome: 'no-change',
    }
  }
  const stateOf = (s: DapSession): string =>
    s.terminated
      ? `terminated (${s.exitDetail || 'exit'})`
      : s.lastStopped
        ? `stopped (${s.lastStopped.reason}, threadId ${s.lastStopped.threadId ?? '?'})`
        : 'running'
  return {
    result: all
      .map(({ id, session }) => {
        const lines = [
          `session '${id}': ${session.program} via ${session.adapterKey} — ${stateOf(session)}`,
        ]
        for (const s of session.treeSessions().slice(1)) {
          lines.push(`  child '${s.label}'${s.depth > 1 ? ` (depth ${s.depth})` : ''}: ${stateOf(s)}`)
        }
        const bps = [...session.treeVerifiedBreakpoints().entries()]
          .map(
            ([f, list]) =>
              `${f}:${list.map(b => `${b.line}${b.verified ? '' : '?'}`).join(',')}`,
          )
          .join(' · ')
        if (bps) lines.push(`  breakpoints: ${bps}`)
        const fbps = session
          .treeVerifiedFunctionBreakpoints()
          .map(b => `${b.name}${b.verified ? '' : '?'}`)
          .join(',')
        if (fbps) lines.push(`  function breakpoints: ${fbps}`)
        return lines.join('\n')
      })
      .join('\n'),
    outcome: 'no-change',
  }
}

export async function loadedSourcesOp(r: { root: DapSession; target: DapSession }): Promise<OpResult> {
  const body = await r.target.request('loadedSources')
  const sources = Array.isArray(body.sources)
    ? (body.sources as Array<{ name?: string; path?: string; sourceReference?: number }>)
    : []
  const shown = sources.slice(0, 100)
  return {
    result: shown.length
      ? shown
          .map(
            s =>
              `${s.path ?? s.name ?? '?'}${s.sourceReference ? ` [sourceReference ${s.sourceReference}]` : ''}`,
          )
          .join('\n') +
        (sources.length > shown.length ? `\n(+${sources.length - shown.length} more)` : '')
      : '(no loaded sources reported)',
    outcome: 'no-change',
  }
}

export async function modulesOp(r: { root: DapSession; target: DapSession }): Promise<OpResult> {
  const body = await r.target.request('modules', { startModule: 0, moduleCount: 100 })
  const modules = Array.isArray(body.modules)
    ? (body.modules as Array<{ name?: string; path?: string; id?: unknown }>)
    : []
  return {
    result: modules.length
      ? modules.map(m => `${m.name ?? '?'}${m.path ? ` (${m.path})` : ''}`).join('\n')
      : '(no modules reported)',
    outcome: 'no-change',
  }
}

export async function sourceOp(r: { root: DapSession; target: DapSession }, input: Input): Promise<OpResult> {
  const body = await r.target.request('source', {
    sourceReference: input.sourceReference,
    source: { sourceReference: input.sourceReference },
  })
  const content = String(body.content ?? '')
  return {
    result: content
      ? content.length > 20_000
        ? content.slice(0, 20_000) + `\n… (${content.length - 20_000} more chars truncated)`
        : content
      : '(empty source)',
    outcome: 'no-change',
  }
}

export async function completionsOp(r: { root: DapSession; target: DapSession }, input: InputWith<'text'>): Promise<OpResult> {
  const body = await r.target.request('completions', {
    text: input.text,
    column: input.text.length + 1,
    ...(input.frameId !== undefined ? { frameId: input.frameId } : {}),
  })
  const targets = Array.isArray(body.targets)
    ? (body.targets as Array<{ label?: string; text?: string; type?: string }>)
    : []
  const shown = targets.slice(0, 50)
  return {
    result: shown.length
      ? shown.map(t => `${t.text ?? t.label ?? '?'}${t.type ? ` (${t.type})` : ''}`).join('\n') +
        (targets.length > shown.length ? `\n(+${targets.length - shown.length} more)` : '')
      : '(no completions)',
    outcome: 'no-change',
  }
}
