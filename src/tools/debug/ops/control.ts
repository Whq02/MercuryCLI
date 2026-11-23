import { type DapSession, removeDapSession } from '../../../integrations/debugger/dapClient.js'
import type { OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import type { Input, InputWith, OpResult } from './schema.js'
import { reportStop, resolveThreadId } from './shared.js'

export async function stepOp(r: { root: DapSession; target: DapSession }, input: Input, wantsInstruction: boolean, signal: AbortSignal | undefined): Promise<OpResult> {
  const threadId = await resolveThreadId(r.target, input.threadId)
  const sinceStamp = r.root.treeNewestStopStamp()
  r.target.lastStopped = null
  await r.target.request(input.op, {
    threadId,
    ...(wantsInstruction ? { granularity: 'instruction' } : {}),
  })
  return await reportStop(r.root, wantsInstruction ? `${input.op} (instruction)` : input.op, sinceStamp, input.timeoutMs, signal)
}

export async function customRequestOp(r: { session: DapSession }, input: InputWith<'method'>, args: Record<string, unknown>): Promise<OpResult> {
  const body = await r.session.request(input.method, args)
  const text = JSON.stringify(body, null, 2) ?? 'null'
  const clipped = text.length > 20_000
  return {
    result:
      `${input.method}:\n` +
      (clipped ? `${text.slice(0, 20_000)}\n… (${text.length - 20_000} more chars)` : text),
    outcome: 'succeeded',
    details: { method: input.method },
  }
}

export async function disconnectOp(owner: OwnerKey, sessionId: string, signal: AbortSignal | undefined, detached: boolean, session: DapSession | undefined): Promise<OpResult> {
  const removed = await removeDapSession(owner, sessionId, signal)
  if (!removed) return { result: `no session '${sessionId}' to disconnect`, outcome: 'no-change' }
  return detached
    ? {
        result: `session '${sessionId}' disconnected (detached — the target keeps running; adapter reaped)`,
        outcome: 'succeeded',
        debuggee: 'running',
      }
    : {
        result: `session '${sessionId}' disconnected (debuggee terminated, adapter reaped)`,
        outcome: 'succeeded',
        ...(session ? { details: { terminalCleanup: session.terminalCleanup } } : {}),
        debuggee: 'terminated',
      }
}
