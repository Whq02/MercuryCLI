import type { MercuryChildSession, TurnEndDetail } from '../childSession.js'
import { selfScriptPath } from '../../../daemon/control/daemonBuild.js'
import type { AcpClientAuthFacts, AcpSignInRoads } from '../acpSignIn.js'
import type { EditorContextWire } from './editorContext.js'
import type { configOptionsFor, modesFor } from './modes.js'

export interface AcpSessionState {
  child: MercuryChildSession
  cwd: string
  modeId: string
  modePath: string
  modeChanges: Promise<void>
  turnResolve: ((outcome: 'success' | 'error' | 'cancelled', detail?: TurnEndDetail) => void) | null
  cancelled: boolean
  promptAbort: AbortController | null
  editorContext: EditorContextWire | null
  toolNames: Map<string, string>
  planChain: Promise<void>
  planEverSent: boolean
  costTotalUsd: number
}

export interface AcpServerOptions {
  entry?: { node: string; script: string }
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  signIn?: AcpSignInRoads
}

export interface AcpServerState {
  readonly sessions: Map<string, AcpSessionState>
  transportClosed: boolean
  clientElicitation: boolean
  clientFormElicitation: boolean
  clientUrlElicitation: boolean
  clientFsReadTextFile: boolean
  clientFsWriteTextFile: boolean
  clientTerminal: boolean
  authFacts: AcpClientAuthFacts
  readonly entry: { node: string; script: string }
  readonly pendingLoads: Map<string, Promise<{
    modes: ReturnType<typeof modesFor>
    configOptions: ReturnType<typeof configOptionsFor>
  }>>
}

export function makeAcpServerState(opts: AcpServerOptions): AcpServerState {
  return {
    sessions: new Map<string, AcpSessionState>(),
    transportClosed: false,
    clientElicitation: false,
    clientFormElicitation: false,
    clientUrlElicitation: false,
    clientFsReadTextFile: false,
    clientFsWriteTextFile: false,
    clientTerminal: false,
    authFacts: { terminalAuth: false, urlElicitation: false },
    entry: opts.entry ?? { node: process.execPath, script: selfScriptPath() },
    pendingLoads: new Map(),
  }
}
