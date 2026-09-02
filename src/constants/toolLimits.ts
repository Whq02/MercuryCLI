// ============================================================================
//  src/constants/toolLimits.ts — tool-result size/token caps. Contract data.
// ============================================================================

/** Default max result size before disk persistence: past this the result is
 *  written to a file and the model receives a preview plus the path.
 *  Individual tools may declare a lower cap; this is the system-wide ceiling
 *  regardless. */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000

export const MAX_TOOL_RESULT_TOKENS = 100_000

export const BYTES_PER_TOKEN = 4

export const MAX_TOOL_RESULT_BYTES = MAX_TOOL_RESULT_TOKENS * BYTES_PER_TOKEN

/** Max aggregate tool_result characters within a SINGLE user message. When a
 *  message's blocks together exceed it, the largest blocks in that message
 *  are persisted and replaced with previews until under budget; messages are
 *  evaluated independently. Stops N parallel tools each landing under the
 *  per-tool cap while collectively blowing the turn. Runtime-overridable by
 *  a feature flag (`mercury_hawthorn_window`). */
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000

/** Max characters for a tool-summary string in compact grouped-agent views. */
export const TOOL_SUMMARY_MAX_LENGTH = 50
