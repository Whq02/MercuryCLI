import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Writable } from 'node:stream'

import { type CancellationToken, type GenericRequestHandler, type Message, type MessageWriter } from 'vscode-jsonrpc'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  Trace,
} from 'vscode-jsonrpc/node.js'
import type { InitializeParams, InitializeResult, ServerCapabilities } from 'vscode-languageserver-protocol'

import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { endProcessTree, endProcessTreeSurvivors } from '../../utils/processGroup.js'
import { passedOver } from '../../utils/passedOver.js'
import { withDeadline } from '../../utils/deadline.js'
import { wasEndedByProcessTreeKill } from '../../utils/platform/processes.js'
import { isBatchShim } from '../../utils/platform/spawn.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'


export type LSPStopResult = {
  outcome: 'exited' | 'killed'
  elapsedMs: number
  exitCode: number | null
  survivors: number[]
}

export type LSPClient = Unbuilt

type QueuedNotification = Unbuilt
type QueuedRequest = { method: string; handler: GenericRequestHandler<unknown, unknown> }

export function createLspMessageWriter(output: Writable): MessageWriter {
  const writer = new StreamMessageWriter(output)
  const write = writer.write.bind(writer)
  writer.write = async (message: Message) => {
    if (output.destroyed || output.writableEnded) return
    try {
      await write(message)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if ((output.destroyed || output.writableEnded) && (code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END' || code === 'EPIPE')) return
      throw error
    }
  }
  return writer
}

function tailStderr(proc: ChildProcessWithoutNullStreams, serverName: string, stderrTail: string[]): void {
  const lines = createInterface({ input: proc.stderr })
  lines.on('line', line => {
    const trimmed = line.trim()
    if (trimmed !== '') {
      logForDebugging(`[lsp:${serverName}] ${trimmed}`)
      stderrTail.push(trimmed.slice(0, 200))
      if (stderrTail.length > 5) stderrTail.shift()
    }
  })
}

function applyQueuedHandlers(conn: MessageConnection, serverName: string, notificationHandlers: QueuedNotification[], requestHandlers: QueuedRequest[]): void {
  for (const entry of notificationHandlers) {
    conn.onNotification(entry.method, entry.handler)
    logForDebugging(`LSP server ${serverName}: applied notification handler ${entry.method}`)
  }
  for (const entry of requestHandlers) {
    conn.onRequest(entry.method, entry.handler)
    logForDebugging(`LSP server ${serverName}: applied request handler ${entry.method}`)
  }
}

export function createLSPClient(serverName: string, onCrash?: (error: Error) => void): LSPClient {
  return notBuilt('src/services/lsp/LSPClient.ts:126')
}
