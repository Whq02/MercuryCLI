// =============================================================================
// workflowConstants.ts
//
// The load-bearing workflow caps live where they are consumed:
// `MAX_SCRIPT_BYTES` / `SYNC_TIMEOUT_MS` in `./compiler.ts` and
// `WORKFLOW_TOOL_NAME` in `./constants.ts` (imported by constants/tools.ts).
// This module is the single, importable workflow-constants surface that
// `WorkflowTool.tsx` and friends resolve `from './workflowConstants.js'`. It
// re-exports the canonical definitions (one source of truth — never duplicate
// the literals) and defines the few small workflow-only constants of this
// surface (aliases, the built-in workflow name, the telemetry-summary cap).
// =============================================================================

// ── Re-exports of the canonical definitions ─────────────────────────────────
// `WORKFLOW_TOOL_NAME` stays canonical in ./constants.ts (it is also imported by
// src/constants/tools.ts); re-export it so both import paths resolve to the same
// value.
export { WORKFLOW_TOOL_NAME } from './constants.js'

// `MAX_SCRIPT_BYTES` is canonical in ./compiler.ts (where script size is
// enforced); the ratified cap is 524288 (= 512 * 1024) — an earlier draft's
// `256 * 1024` was the inaccurate one. `SYNC_TIMEOUT_MS` is the VM run
// timeout. Re-export both rather than re-declaring the literals so there is
// one source of truth.
export { MAX_SCRIPT_BYTES, SYNC_TIMEOUT_MS } from './compiler.js'

/**
 * Alias for `SYNC_TIMEOUT_MS` — the synchronous-execution timeout handed to
 * `runInContext()`. Kept as a named re-export for callers that reach for the
 * engine-side name.
 */
export { SYNC_TIMEOUT_MS as VM_SYNC_TIMEOUT_MS } from './compiler.js'

// ── Workflow-only constants of this surface ─────────────────────────────────

/**
 * Telemetry-truncation length for the built-in workflow description shown in
 * tool-use summaries.
 */
export const MAX_TOOL_USE_SUMMARY = 200
