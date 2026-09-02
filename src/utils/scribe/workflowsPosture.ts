// ============================================================================
//  Implementer WORKFLOWS posture — the session-scoped intent bit behind the
//  "Scribe + workflows" /model row (MERCURY_SCRIBE_WORKFLOWS).
// ----------------------------------------------------------------------------
//  The /model workflows variant arms it in the FOREGROUND session; the scribe
//  engage (ensureScribeDaemon → buildScribeDaemonExtraEnv) stamps it onto the
//  auto-started daemon as MERCURY_DAEMON_SCRIBE_WORKFLOWS=1; the daemon stamps
//  the Implementer child spec with MERCURY_IMPLEMENTER_WORKFLOWS=1 (spec-carried,
//  so supervisor respawns keep it); implementerMode.ts selects the
//  workflow-capable pack variant off that env. Module state only — never
//  persisted; a fresh session starts un-armed. Standalone module (no scribeMode
//  import) so ensureScribeDaemon can read it without an import cycle.
// ============================================================================

let workflowsPosture = false

/** Arm/disarm the Implementer workflows posture (session-scoped). */
export function setImplementerWorkflowsPosture(on: boolean): void {
  workflowsPosture = on
}

/** Whether the next scribe engage should spawn a workflow-capable Implementer. */
export function getImplementerWorkflowsPosture(): boolean {
  return workflowsPosture
}
