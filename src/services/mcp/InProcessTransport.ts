import type { Transport } from '../../utils/mcp/sdk.js'
import type { JSONRPCMessage } from '../../utils/mcp/sdk.js'
import { startMicrotask } from '../../utils/timers.js'
import { notBuilt } from '../../pi/holes.js'

export function createLinkedTransportPair(): [Transport, Transport] {
  return notBuilt('src/services/mcp/InProcessTransport.ts:42')
}
