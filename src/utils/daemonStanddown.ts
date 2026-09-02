// ============================================================================
//  daemonStanddown — the /halt stand-down latch (workflow-hardening defect 5).
//
//  The burn (the operator's evening): /halt reported "daemon halted
//  (reaped 5 workers)"; an immediate second /halt reaped 4 MORE. The hard
//  stop killed the daemon, and a SILENT auto-heal path (the switchboard's
//  tool/enter heal, the scribe engage's liveness ensure) stood a fresh
//  daemon — with its boot seats — right back up.
//
//  The law: /halt is the operator saying STOP. After it, no silent path
//  re-spawns an owned daemon in this session. Only an EXPLICIT operator
//  gesture — engaging Scribe in /model, engaging the crew/party from their
//  boards, or running `mercury daemon` (a different process, out of this
//  latch's reach by construction) — lifts the stand-down.
//
//  Process-local by design: the latch is "this operator, this session, said
//  stop", not machine state. A new session starts clear.
// ============================================================================

let haltStanddown = false

/** /halt calls this: silent daemon auto-heals stand down from now on. */
export function markDaemonHaltStanddown(): void {
  haltStanddown = true
}

/** An explicit engage gesture calls this: the operator asked for the
 *  daemon again, so the silent heals may serve it too. */
export function clearDaemonHaltStanddown(): void {
  haltStanddown = false
}

/** Consulted by every SILENT auto-heal/ensure path before spawning. */
export function daemonHaltStanddownActive(): boolean {
  return haltStanddown
}
