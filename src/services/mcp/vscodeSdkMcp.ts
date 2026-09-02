import { z } from 'zod'

import { MERCURY_VERSION } from '../../constants/product.js'

import { flagEnabled } from '../../substrate/flagRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import type { ConnectedMCPServer, MCPServerConnection } from './types.js'
import { setMcpNotificationHandler } from './zodInstanceSeam.js'

export const EDITOR_COMPANION_CLIENT_NAME = 'mercury-editor-companion'

const HANDSHAKE_METHOD = 'mercury_capability_handshake'
const FILE_UPDATED_METHOD = 'file_updated'
const LOG_EVENT_METHOD = 'log_event'

export const editorLogEventSchema = lazySchema(() =>
  z.object({
    method: z.literal(LOG_EVENT_METHOD),
    params: z.object({
      eventName: z.string(),
      eventData: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
)

let companionClient: ConnectedMCPServer | null = null

function buildCapabilityHandshake(): Record<string, unknown> {
  const capabilities: Record<string, unknown> = {}
  capabilities.version = MERCURY_VERSION
  capabilities.fileUpdates = true
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

export function registerEditorCompanion(sdkClients: MCPServerConnection[]): void {
  const found = sdkClients.find(
    (entry): entry is ConnectedMCPServer =>
      entry.type === 'connected' && entry.name === EDITOR_COMPANION_CLIENT_NAME,
  )
  if (!found) {
    companionClient = null
    return
  }
  if (found === companionClient) return
  companionClient = found
  try {
    setMcpNotificationHandler(found.client, editorLogEventSchema(), () => {
    })
  } catch (error) {
    logError(error)
  }
  found.client
    .notification({ method: HANDSHAKE_METHOD, params: { capabilities: buildCapabilityHandshake() } })
    .catch(error => {
      logForDebugging(`editor companion: ${HANDSHAKE_METHOD} notification failed: ${String(error)}`)
    })
}

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
