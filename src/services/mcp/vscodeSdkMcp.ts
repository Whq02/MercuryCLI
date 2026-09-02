// ============================================================================
// vscodeSdkMcp — the SDK companion channel.
//
//  Covers the case where Mercury runs EMBEDDED by an editor through the SDK
//  and the editor injects a companion MCP client (distinct from the `ide`
//  bridge connection): setup binds the reserved Mercury-own companion entry,
//  accepts the editor's `log_event` notification (inert body — no telemetry
//  sink exists by design), and pushes one Mercury-own capability handshake.
//  Foreign experiment-gate keys are not reproduced; handshake values come from
//  Mercury's own resolvers and unknown values are OMITTED so the editor fails
//  closed.
//
//  Binding: `registerEditorCompanion` is called with the SDK client list
//  each time the SDK MCP clients are (re)connected; a list without a
//  connected companion clears the binding, and `notifyVscodeFileUpdated`
//  is then a silent no-op by design — an editor that injected no companion
//  has nothing to refresh. The ACP bridge (services/acp) is a different
//  door: it does not embed Mercury through the SDK and reads file changes
//  from the tool-call wire instead.
// ============================================================================
import { z } from 'zod'

import { MERCURY_VERSION } from '../../constants/product.js'

import { flagEnabled } from '../../substrate/flagRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import type { ConnectedMCPServer, MCPServerConnection } from './types.js'
import { setMcpNotificationHandler } from './zodInstanceSeam.js'

/**
 * The reserved name of the SDK-injected editor-companion client. Mercury-own
 * (identity mandate): exported so an embedding editor and the harness agree
 * on one spelling. The enterprise-MCP carve-out in config.ts still names
 * the foreign SDK entry and is a separately-owned survivor.
 */
export const EDITOR_COMPANION_CLIENT_NAME = 'mercury-editor-companion'

/** Companion wire methods (harness-defined; the counterpart contract). */
const HANDSHAKE_METHOD = 'mercury_capability_handshake'
const FILE_UPDATED_METHOD = 'file_updated'
const LOG_EVENT_METHOD = 'log_event'

/**
 * The editor's log-event notification. Built with OUR zod, registered across
 * the SDK boundary only through the zod-instance seam. Shape matches the
 * bridge-side handler in useIdeLogging.ts — one wire, one shape.
 */
export const editorLogEventSchema = lazySchema(() =>
  z.object({
    method: z.literal(LOG_EVENT_METHOD),
    params: z.object({
      eventName: z.string(),
      eventData: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
)

/** The bound companion connection; null until a registration list carries one. */
let companionClient: ConnectedMCPServer | null = null

/**
 * The Mercury-own handshake record. Every value must come from a live
 * resolver; a value that cannot be resolved is omitted, never guessed.
 */
function buildCapabilityHandshake(): Record<string, unknown> {
  const capabilities: Record<string, unknown> = {}
  capabilities.version = MERCURY_VERSION
  // This module's own notifier — a fact of this build, not a probe.
  capabilities.fileUpdates = true
  // Registered gates, re-read live through the flag registry.
  try {
    capabilities.closedLoop = flagEnabled('MERCURY_IDE_LOOP')
  } catch (error) {
    logError(error)
  }
  try {
    capabilities.autoCapture = flagEnabled('MERCURY_TX_AUTOCAPTURE')
  } catch (error) {
    logError(error)
  }
  return capabilities
}

/**
 * Bind the reserved companion client out of the SDK-injected connection list:
 * store the reference, accept `log_event` (so the editor never errors), and
 * push the capability handshake once per connection. The list is the truth —
 * a list without a connected companion clears the binding, returning the
 * notifier to its silent no-op.
 */
export function registerEditorCompanion(sdkClients: MCPServerConnection[]): void {
  const found = sdkClients.find(
    (entry): entry is ConnectedMCPServer =>
      entry.type === 'connected' && entry.name === EDITOR_COMPANION_CLIENT_NAME,
  )
  if (!found) {
    companionClient = null
    return
  }
  // Same connection object: handler and handshake were already delivered.
  if (found === companionClient) return
  companionClient = found
  try {
    setMcpNotificationHandler(found.client, editorLogEventSchema(), () => {
      // Accepted, not sinked: the handler body is deliberately inert.
    })
  } catch (error) {
    // Registration failure must not lose the notifier arm.
    logError(error)
  }
  found.client
    .notification({ method: HANDSHAKE_METHOD, params: { capabilities: buildCapabilityHandshake() } })
    .catch(error => {
      logForDebugging(`editor companion: ${HANDSHAKE_METHOD} notification failed: ${String(error)}`)
    })
}

/**
 * Tell the companion editor a file changed so it can refresh buffers.
 * Fire-and-forget: called synchronously on every mutation path (file edit,
 * file write, change-set, sed-in-place, file-history restore) and must never
 * throw or block there. Without a bound companion it is a silent no-op; a
 * send failure is debug-logged, never surfaced.
 */
export function notifyVscodeFileUpdated(
  filePath: string,
  oldContents: string | null,
  newContents: string | null,
): void {
  const companion = companionClient
  if (!companion) return
  companion.client
    .notification({ method: FILE_UPDATED_METHOD, params: { filePath, oldContents, newContents } })
    .catch(error => {
      logForDebugging(`editor companion: ${FILE_UPDATED_METHOD} notification failed: ${String(error)}`)
    })
}
