import { appendFileSync, readSync, writeSync } from 'node:fs'

function readBytes(size) {
  const bytes = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const count = readSync(0, bytes, offset, size - offset, null)
    if (count === 0) {
      if (offset === 0) return null
      throw new Error('incomplete filter packet')
    }
    offset += count
  }
  return bytes
}
function group() {
  const packets = []
  for (;;) {
    const header = readBytes(4)
    if (header === null) return null
    const size = Number.parseInt(header.toString(), 16)
    if (size === 0) return packets
    if (!Number.isFinite(size) || size < 4) throw new Error('invalid filter packet')
    const data = readBytes(size - 4)
    if (data === null) throw new Error('missing filter body')
    packets.push(data)
  }
}
function writeBytes(bytes) {
  let offset = 0
  while (offset < bytes.length) offset += writeSync(1, bytes, offset, bytes.length - offset)
}
function packet(data) {
  const bytes = Buffer.from(data)
  writeBytes(Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, '0')), bytes]))
}
const flush = () => writeBytes(Buffer.from('0000'))
if (group()?.map(p => p.toString()).join('') !== 'git-filter-client\nversion=2\n') throw new Error('unexpected filter handshake')
packet('git-filter-server\n')
packet('version=2\n')
flush()
group()
packet('capability=clean\n')
flush()
for (;;) {
  const headers = group()
  if (headers === null) break
  if (!headers.some(p => p.toString() === 'command=clean\n')) throw new Error('unexpected filter command')
  const path = headers.find(p => p.toString().startsWith('pathname='))
  const content = group()
  if (path === undefined || content === null) throw new Error('incomplete clean request')
  appendFileSync(process.argv[2], path)
  packet('status=success\n')
  flush()
  for (const data of content) packet(data)
  flush()
  flush()
}
