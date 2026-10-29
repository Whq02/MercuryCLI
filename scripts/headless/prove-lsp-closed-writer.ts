import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { createLspMessageWriter } from '../../src/services/lsp/LSPClient.ts'

const message = { jsonrpc: '2.0', id: 1, result: null }
const destroyed = new Writable({ write(_chunk, _encoding, callback) { callback() } })
destroyed.on('error', () => {})
const stoppedWriter = createLspMessageWriter(destroyed)
destroyed.destroy()
await assert.doesNotReject(stoppedWriter.write(message), 'a queued LSP reply after pipe destruction settles without a rejected write')

let writes = 0
const closing = new Writable({ write(_chunk, _encoding, callback) { writes++; callback(); closing.destroy() } })
closing.on('error', () => {})
await assert.doesNotReject(createLspMessageWriter(closing).write(message), 'closure between the JSON-RPC header and body settles')
assert.equal(writes, 1)

const chunks: Buffer[] = []
const live = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback() } })
await createLspMessageWriter(live).write(message)
const body = JSON.stringify(message)
assert.equal(Buffer.concat(chunks).toString(), `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)

const broken = new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error('write failed'), { code: 'EIO' })) } })
broken.on('error', () => {})
await assert.rejects(createLspMessageWriter(broken).write(message), /write failed/, 'non-closure errors still reject')
live.destroy()
console.log('PASS LSP replies settle after pipe closure; live bytes and genuine write failures are preserved')
