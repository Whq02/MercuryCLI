
import { Readable, Writable } from 'node:stream'
import { agent, ndJsonStream } from '@agentclientprotocol/sdk'
import { makeAcpServerState, type AcpServerOptions } from './server/state.js'
import { sessionRequests } from './server/sessionRequests.js'
import { mercuryRequests } from './server/mercuryRequests.js'
import { registerBootDoors } from '../../boot/doors/registerDoors.js'

export { permissionAskWire, permissionAllowedOf, permissionAnswerOf } from './server/asks.js'
export { toolKindOf, toolLocationsOf, toolDiffsOf, TOOL_OUTPUT_WIRE_LIMIT, boundedToolText, toolOutputContentOf, stopReasonOf, acpMcpServersToConfig, planEntriesOf, usageWireOf } from './server/toolWire.js'
export { editorContextOf, editorContextResource } from './server/editorContext.js'
export { replayUpdatesOf } from './server/replay.js'
export { acpPromptToComposerDocument, composerDocumentBlocks } from './server/prompt.js'
export { attentionWire, attentionWireFromSnapshot } from './server/attention.js'

export async function runAcpServer(opts: AcpServerOptions = {}): Promise<void> {
  registerBootDoors()
  const server = makeAcpServerState(opts)
  const { sessions } = server
  const app = mercuryRequests(sessionRequests(agent({ name: 'mercury' }), server, opts))

  const input = Writable.toWeb(
    (opts.output ?? process.stdout) as NodeJS.WriteStream,
  ) as WritableStream<Uint8Array>
  const output = Readable.toWeb(
    (opts.input ?? process.stdin) as NodeJS.ReadStream,
  ) as ReadableStream<Uint8Array>
  const connection = app.connect(ndJsonStream(input, output))
  await connection.closed
  server.transportClosed = true
  const closes: Promise<void>[] = []
  for (const state of new Set(sessions.values())) {
    if (state.turnResolve) {
      const resolveTurn = state.turnResolve
      state.turnResolve = null
      resolveTurn('cancelled')
    }
    closes.push(state.child.close())
  }
  await Promise.all(closes)
}
