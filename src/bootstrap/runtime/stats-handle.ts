// ============================================================================
//  src/bootstrap/runtime/stats-handle.ts — the stats-store owner
//  (family; slimmed when the OTel telemetry estate
//  was deleted under ruling 6 — this owner keeps the one live seam
//  the old telemetry-handles owner carried: the frame/duration stats store
//  interactiveHelpers wires at render boot).
//
//  Scope: PROCESS — set once by interactiveHelpers when the render root
//  mounts; observed by hook/tool execution for duration stats.
//
//  BOOTSTRAP-ISOLATION LEAF (the same custom-rules/bootstrap-isolation
//  convention state.ts carries): this module imports ONLY types. No
//  src/utils value imports. src/bootstrap/state.ts is the ONLY sanctioned
//  importer; every consumer goes through the frozen facade.
// ============================================================================

export class StatsHandleOwner {
  statsStore: { observe(name: string, value: number): void } | null = null
}
