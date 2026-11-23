import { DapCancelledError } from '../../../integrations/debugger/dapCancellation.js'
import type { DapSession } from '../../../integrations/debugger/dapClient.js'
import type { OpResult } from './schema.js'

export async function resolveThreadId(session: DapSession, explicit?: number): Promise<number> {
  if (explicit !== undefined) return explicit
  if (session.lastStopped?.threadId !== undefined) return session.lastStopped.threadId
  const body = await session.request('threads')
  const threads = Array.isArray(body.threads)
    ? (body.threads as Array<{ id?: number }>)
    : []
  const first = threads[0]?.id
  if (first === undefined) throw new Error('no threads reported by the adapter')
  return first
}

export async function formatStackTop(session: DapSession, threadId: number, depth = 3): Promise<string> {
  const body = await session.request('stackTrace', { threadId, startFrame: 0, levels: depth })
  const frames = Array.isArray(body.stackFrames)
    ? (body.stackFrames as Array<{
        id?: number
        name?: string
        line?: number
        source?: { path?: string; name?: string }
        instructionPointerReference?: string
      }>)
    : []
  if (frames.length === 0) return '(no frames)'
  return frames
    .map(
      (f, i) =>
        `#${i} ${f.name ?? '?'} (${f.source?.path ?? f.source?.name ?? '?'}:${f.line ?? '?'})` +
        (f.id !== undefined ? ` [frameId ${f.id}]` : '') +
        (f.instructionPointerReference ? ` [ip ${f.instructionPointerReference}]` : ''),
    )
    .join('\n')
}

export async function reportStop(root: DapSession, label: string, sinceStamp = 0, timeoutMs = 10_000, signal?: AbortSignal): Promise<OpResult> {
  const outcome = await root.waitForStopOutcome(timeoutMs, signal, sinceStamp)
  if (outcome.state === 'aborted') throw new DapCancelledError()
  if (outcome.state === 'terminated') {
    await root.drainOutput(200, 1_000, signal)
    const tail = root.output.slice(-8).join('\n')
    return {
      result: `${label}: ${root.debuggeeEndDetail()}${tail ? `\noutput:\n${tail}` : ''}`,
      outcome: 'succeeded',
      debuggee: 'terminated',
    }
  }
  if (outcome.state === 'timeout') {
    return {
      result: `${label}: still running after ${timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`} — op:"pause" to interrupt, op:"output" to inspect`,
      outcome: 'succeeded',
      debuggee: 'running',
    }
  }
  const stopped = outcome.info
  const at = outcome.session
  const threadId = stopped.threadId
  const top =
    threadId !== undefined
      ? await formatStackTop(at, threadId).catch(e => `(stack unavailable: ${(e as Error).message})`)
      : '(no thread)'
  const topLine = top.split('\n')[0] ?? ''
  const frameMatch = topLine.match(/^#0 (.+) \((.+):(\d+)\)/)
  const verifiedBreakpoints = [...root.treeVerifiedBreakpoints().values()]
    .flat()
    .filter(b => b.verified).length
  return {
    result:
      `${label}: stopped${at !== root ? ` in '${at.label}'` : ''} — reason ${stopped.reason}` +
      (stopped.description ? ` (${stopped.description})` : '') +
      (threadId !== undefined ? `, threadId ${threadId}` : '') +
      `\n${top}`,
    outcome: 'succeeded',
    debuggee: 'stopped',
    details: {
      stopCard: {
        reason: stopped.reason,
        ...(stopped.description ? { description: stopped.description } : {}),
        ...(threadId !== undefined ? { threadId } : {}),
        ...(at !== root ? { session: at.label } : {}),
        ...(frameMatch
          ? {
              topFrame: {
                name: frameMatch[1],
                path: frameMatch[2],
                line: Number(frameMatch[3]),
              },
            }
          : {}),
        verifiedBreakpoints,
      },
    },
  }
}


export function instructionLabel(spec: { instructionReference: string; offset?: number }): string {
  if (!spec.offset) return spec.instructionReference
  return `${spec.instructionReference}${spec.offset > 0 ? '+' : ''}${spec.offset}`
}

export function verdictText(verdict: { verified: boolean; message?: string } | undefined): string {
  return `${verdict?.verified ? 'verified' : 'UNVERIFIED'}${verdict?.message ? ` (${verdict.message})` : ''}`
}
