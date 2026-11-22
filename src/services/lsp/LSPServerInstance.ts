import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { InitializeParams, ServerCapabilities } from 'vscode-languageserver-protocol'

import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { languageServerEnv } from '../../utils/subprocessEnv.js'
import type { ExecutionState } from '../../utils/primitives/execution.js'
import { projectExternalState } from '../../utils/primitives/externalProjection.js'
import { processMainOwner } from '../../utils/run/resolveOwner.js'
import { lspLedgerNow } from './failureLedger.js'
import { missingRustAnalyzerComponent, startFailureCause } from './failureWords.js'
import type { LSPClient, LSPStopResult } from './LSPClient.js'
import { currentLspAbortSignal, currentLspCall } from './lspAbort.js'
import { mercuryLspEnabled } from './mercuryLsp.js'
import type { LspServerState, ScopedLspServerConfig } from './types.js'
import type { LspServerRecord } from './LSPServerInstance/record.js'
import { sendNotificationOf, sendRequestOf } from './LSPServerInstance/requests.js'
import { withDeadline } from '../../utils/deadline.js'
import { passedOver } from '../../utils/passedOver.js'
import { startTimeout, stopTimeout } from '../../utils/timers.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'


export type LSPServerInstance = Unbuilt

const DEFAULT_MAX_RESTARTS = 3

export type LspStartFailure = Error & { server: string; attempts: number; lspCause: string; refused?: boolean; retryAt?: number }

function startFailure(server: string, attempts: number, cause: unknown): LspStartFailure {
  const lspCause = startFailureCause(server, cause)
  const error: LspStartFailure = Object.assign(
    new Error(`LSP server ${server} did not start (${attempts} attempt${attempts === 1 ? '' : 's'} this session): ${lspCause}`),
    { server, attempts, lspCause },
  )
  error.name = 'LspStartFailure'
  return error
}

export function isLspStartFailure(err: unknown): err is LspStartFailure {
  return err instanceof Error && err.name === 'LspStartFailure'
}

const INIT_BACKOFF_BASE_MS = 15_000
const INIT_BACKOFF_MAX_MS = 5 * 60_000


function planeState(state: LspServerState): ExecutionState {
  return state === 'error' ? 'failed' : state
}

function projectState(name: string, state: LspServerState, error?: Error): void {
  projectExternalState(
    processMainOwner(),
    {
      id: `language-server:${name}`,
      kind: 'language-server',
      label: `language server ${name}`,
      lifecycle: 'session',
      metadata: { serverName: name },
    },
    planeState(state),
    error !== undefined && state === 'error' ? { outcome: { reason: error.message } } : {},
  )
}


export function createLSPServerInstance(name: string, config: ScopedLspServerConfig): LSPServerInstance {
  return notBuilt('src/services/lsp/LSPServerInstance.ts:143')
}
