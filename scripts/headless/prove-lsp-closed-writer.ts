import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { createLspMessageWriter } from '../../src/integrations/lsp/LSPClient.ts'

const message = { jsonrpc: '2.0', id: 1, result: null }
const destroyed = new Writable({ write(_chunk, _encoding, callback) { callback() } })
destroyed.on('error', () => {})
const stoppedWriter = createLspMessageWriter(destroyed)
destroyed.destroy()
await assert.doesNotReject(stoppedWriter.write(message), 'a queued LSP reply after pipe destruction settles without a rejected write; fix the closed-pipe early return and the ERR_STREAM_DESTROYED, ERR_STREAM_WRITE_AFTER_END and EPIPE swallow in createLspMessageWriter in src/integrations/lsp/LSPClient.ts')

let writes = 0
const closing = new Writable({ write(_chunk, _encoding, callback) { writes++; callback(); closing.destroy() } })
closing.on('error', () => {})
await assert.doesNotReject(createLspMessageWriter(closing).write(message), 'closure between the JSON-RPC header and body settles; fix the catch in createLspMessageWriter in src/integrations/lsp/LSPClient.ts so a destroyed or ended output swallows closure errors')
assert.equal(writes, 1, 'the writer should reach the stream exactly once before closure; check createLspMessageWriter in src/integrations/lsp/LSPClient.ts, which wraps StreamMessageWriter.write')

const chunks: Buffer[] = []
const live = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback() } })
await createLspMessageWriter(live).write(message)
const body = JSON.stringify(message)
assert.equal(Buffer.concat(chunks).toString(), `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, 'a live output should receive Content-Length framing then the JSON body unchanged; check createLspMessageWriter in src/integrations/lsp/LSPClient.ts does not alter the bytes StreamMessageWriter writes')

const broken = new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error('write failed'), { code: 'EIO' })) } })
broken.on('error', () => {})
await assert.rejects(createLspMessageWriter(broken).write(message), /write failed/, 'non-closure errors still reject; createLspMessageWriter in src/integrations/lsp/LSPClient.ts must rethrow any error that is not a closure error on a destroyed or ended output')
live.destroy()
console.log('PASS LSP replies settle after pipe closure; live bytes and genuine write failures are preserved')
