
import { Readable, Writable } from 'node:stream'
import { agent, ndJsonStream } from '@agentclientprotocol/sdk'
import { makeAcpServerState, type AcpServerOptions } from './acpServer/state.js'
import { sessionRequests } from './acpServer/sessionRequests.js'
import { mercuryRequests } from './acpServer/mercuryRequests.js'
import { registerBootDoors } from '../boot/registerDoors.js'

export { permissionAskWire, permissionAllowedOf, permissionAnswerOf } from './acpServer/asks.js'
export { toolKindOf, toolLocationsOf, toolDiffsOf, TOOL_OUTPUT_WIRE_LIMIT, boundedToolText, toolOutputContentOf, stopReasonOf, acpMcpServersToConfig, planEntriesOf, usageWireOf } from './acpServer/toolWire.js'
export { editorContextOf, editorContextResource } from './acpServer/editorContext.js'
export { replayUpdatesOf } from './acpServer/replay.js'
export { acpPromptToComposerDocument, composerDocumentBlocks } from './acpServer/prompt.js'
export { attentionWire, attentionWireFromSnapshot } from './acpServer/attention.js'

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
