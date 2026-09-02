// ============================================================================
//  switchboard/attachedSession — the HAND-BACK door for records an earlier
//  build left behind.
//
//  Every session is a full chat; a session the daemon hosts is entered by
//  re-pointing the focused slot at its connector (engine-connector/
//  daemonConnector — the hop). Nothing is yielded, drained, killed, swapped
//  or respawned by a hop, so no record is ever stamped attached by THIS
//  build. What remains here is the durable hand-back for records an earlier
//  build's one-terminal swap stamped `attachedAt`: the board pump replays
//  the retry marker and heals records whose terminal is gone, so those
//  sessions live on the board again and deliveries reach them.
// ============================================================================

/** The hand-back that CANNOT fail silently. Writes the durable retry marker
 *  FIRST, heals the daemon, sends the op, and clears the marker only on a
 *  settling receipt — a transport loss leaves the marker for the board pump
 *  (even across an app restart). Returns true when the hand-back applied.
 *  No hop ever mints one; the pump replays markers an earlier build left
 *  and hands back records still stamped as with-you by a terminal that is
 *  gone (healStaleAttachRecords). */
export async function completeHandback(
  kind: 'detach' | 'valve-resume' | 'grant-workflows',
  sessionId: string,
  opts?: { mintedAtMs?: number },
): Promise<boolean> {
  try {
    // A pump REPLAY passes the marker's ORIGINAL mint time — the daemon
    // compares it to the latest attach grant; re-minting fresh here would
    // blind that staleness guard.
    const mintedAtMs = opts?.mintedAtMs ?? Date.now()
    const store = await import('../concourse/concourseSnapshot.js')
    await store.writeConcoursePendingHandback({ kind, sessionId, mintedAtMs })
    const { ensureOwnedDaemon } = await import('./ensureDaemon.js')
    await ensureOwnedDaemon()
    const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
    const action = kind === 'detach' ? 'detach' : kind === 'grant-workflows' ? 'grant-workflows' : 'resume'
    const reply = (await daemonControlRpc(
      { op: 'sessionControl', action, sessionId, by: 'operator', mintedAtMs } as never,
      { timeoutMs: 20_000 },
    )) as { ok?: boolean; outcome?: string; detail?: string }
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
  } catch {
    return false // the marker persists — the pump replays it
  }
}

/** A record stamped attachedAt by a terminal that no longer exists (an
 *  earlier build's one-terminal swap, its process gone) is handed back so
 *  the session lives on the board again and deliveries reach it. Returns
 *  how many hand-backs applied. Records held by a LIVE process are left
 *  alone (that terminal owns them). */
export async function healStaleAttachRecords(): Promise<number> {
  let healed = 0
  try {
    const sup = await import('../../daemon/concourseSupervisor.js')
    const { isProcessAlive } = await import('../../daemon/ownerWatch.js')
    for (const rec of Object.values(sup.readSessionWorkers())) {
      if (rec.endedAt !== undefined || rec.attachedAt === undefined) continue
      const pid = /^operator:(\d+)$/.exec(rec.attachedBy ?? '')?.[1]
      const heldByLive = pid !== undefined && isProcessAlive(Number(pid))
      if (heldByLive) continue
      if (await completeHandback('detach', rec.sessionId)) healed++
    }
  } catch {
    /* the records are a projection — the next pump beat retries */
  }
  return healed
}
