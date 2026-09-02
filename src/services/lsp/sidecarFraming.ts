// ============================================================================
//  lsp/sidecarFraming — the ONE JSON-RPC base-protocol framing owner for
//  Mercury's in-bundle LSP sidecars (mercury-ts since, mercury-web
//  since). Extracted VERBATIM from tsSidecar/sidecar.ts so a second
//  sidecar never grows a parallel copy.
//
//  Content-Length framed JSON-RPC 2.0 per the LSP base protocol. Zero deps.
// ============================================================================

import type { Writable } from 'node:stream'

export type JsonRpcId = number | string | null

export interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export const RPC_PARSE_ERROR = -32700
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INTERNAL_ERROR = -32603
export const RPC_SERVER_NOT_INITIALIZED = -32002

export function createFrameWriter(output: Writable): (msg: JsonRpcMessage) => void {
  return msg => {
    const body = Buffer.from(JSON.stringify(msg), 'utf8')
    output.write(`Content-Length: ${body.length}\r\n\r\n`)
    output.write(body)
  }
}

/**
 * Incremental Content-Length frame parser. Feeds complete JSON bodies to
 * `onMessage`; malformed JSON gets a ParseError response (when an id can't
 * be recovered, the error id is null per JSON-RPC 2.0).
 */
export function createFrameReader(
  onMessage: (msg: JsonRpcMessage) => void,
  onProtocolError: (err: Error) => void,
): (chunk: Buffer) => void {
  let buffer = Buffer.alloc(0)
  let expected: number | null = null

  return chunk => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (expected === null) {
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        const header = buffer.subarray(0, headerEnd).toString('ascii')
        const match = /content-length:\s*(\d+)/i.exec(header)
        if (!match || !match[1]) {
          onProtocolError(new Error('missing Content-Length header'))
          buffer = Buffer.alloc(0)
          return
        }
        expected = Number(match[1])
        buffer = buffer.subarray(headerEnd + 4)
      }
      if (buffer.length < expected) return
      const body = buffer.subarray(0, expected).toString('utf8')
      buffer = buffer.subarray(expected)
      expected = null
      try {
        onMessage(JSON.parse(body) as JsonRpcMessage)
      } catch {
        onProtocolError(new Error('unparseable JSON-RPC body'))
      }
    }
  }
}
