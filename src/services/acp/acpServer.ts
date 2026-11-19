
import { Readable, Writable } from 'node:stream'
import { agent, ndJsonStream } from '@agentclientprotocol/sdk'
import '../../utils/artifacts/reviewStore.js'
import '../../substrate/sourceState.js'
import '../run/runCoordinator.js'
import '../run/runSidecar.js'
import '../run/resolveOwner.js'
import '../run/ownerKey.js'
import '../../utils/cwd.js'
import '../../utils/listSessionsImpl.js'
import '../../utils/sessionStorage/paths.js'
import '../../utils/sessionStorage/loading.js'
import '../../utils/sessionStorage/chain.js'
import '../../utils/sessionStorage/logs.js'
import '../engine-connector/midTurnText.js'
import '../../utils/messages/factories.js'
import '../../utils/messages/rejectionText.js'
import '../../utils/messages/text.js'
import '../../constants/xml.js'
import '../../rows/project.js'
import '../../substrate/fileStore.js'
import '../../constants/product.js'
import '../workbench/projection.js'
import '../workbench/attentionBridge.js'
import '../../input-core/composer-document.js'
import '../../services/attention/contracts.js'
import '../../services/attention/relations.js'
import '../../utils/tasks.js'
import '../../utils/model/capabilities.js'
import './childSession.js'
import '../../daemon/daemonBuild.js'
import '../../utils/permissions/permissionSetup.js'
import '../../types/permissions.js'
import '../../utils/permissions/PermissionMode.js'
import '../../utils/settings/validationTips.js'
import './questionForm.js'
import './acpSignIn.js'
import { makeAcpServerState, type AcpServerOptions } from './acpServer/state.js'
import { sessionRequests } from './acpServer/sessionRequests.js'
import { mercuryRequests } from './acpServer/mercuryRequests.js'

export { permissionAskWire, permissionAllowedOf, permissionAnswerOf } from './acpServer/asks.js'
export { toolKindOf, toolLocationsOf, toolDiffsOf, TOOL_OUTPUT_WIRE_LIMIT, boundedToolText, toolOutputContentOf, stopReasonOf, acpMcpServersToConfig, planEntriesOf, usageWireOf } from './acpServer/toolWire.js'
export { editorContextOf, editorContextResource } from './acpServer/editorContext.js'
export { replayUpdatesOf } from './acpServer/replay.js'
export { acpPromptToComposerDocument, composerDocumentBlocks } from './acpServer/prompt.js'
export { attentionWire, attentionWireFromSnapshot } from './acpServer/attention.js'

export async function runAcpServer(opts: AcpServerOptions = {}): Promise<void> {
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
