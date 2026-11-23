import { passedOver } from '../../platform/errors/passedOver.js'

export async function completeHandback(
  kind: 'detach' | 'valve-resume' | 'grant-workflows',
  sessionId: string,
  opts?: { mintedAtMs?: number },
): Promise<boolean> {
  try {
    const mintedAtMs = opts?.mintedAtMs ?? Date.now()
    const store = await import('../../screen/concourse-model/concourseSnapshot.js')
    await store.writeConcoursePendingHandback({ kind, sessionId, mintedAtMs })
    const { ensureOwnedDaemon } = await import('./ensureDaemon.js')
    await ensureOwnedDaemon()
    const { daemonControlRpc } = await import('../control/controlSocket.js')
    const action = kind === 'detach' ? 'detach' : kind === 'grant-workflows' ? 'grant-workflows' : 'resume'
    const reply = await daemonControlRpc(
      { op: 'sessionControl', action, sessionId, by: 'operator', mintedAtMs },
      { timeoutMs: 20_000 },
    )
    const applied = reply.ok === true && (reply.outcome === 'applied' || reply.outcome === 'noop')
    const nothingToDo =
      reply.ok === true &&
      reply.outcome === 'refused' &&
      typeof reply.detail === 'string' &&
      (reply.detail.includes('unknown-session') || reply.detail.includes('re-entered'))
    if (applied || nothingToDo) {
      await store.writeConcoursePendingHandback(null)
    }
    return applied
  } catch (error) {
    passedOver(error)
    return false
  }
}

export async function healStaleAttachRecords(): Promise<number> {
  let healed = 0
  try {
    const sup = await import('../concourse-workers/concourseWorkers.js')
    const { isProcessAlive } = await import('../control/ownerWatch.js')
    for (const rec of Object.values(sup.readSessionWorkers())) {
      if (rec.endedAt !== undefined || rec.attachedAt === undefined) continue
      const pid = /^operator:(\d+)$/.exec(rec.attachedBy ?? '')?.[1]
      const heldByLive = pid !== undefined && isProcessAlive(Number(pid))
      if (heldByLive) continue
      if (await completeHandback('detach', rec.sessionId)) healed++
    }
  } catch (error) {
    passedOver(error)
  }
  return healed
}
