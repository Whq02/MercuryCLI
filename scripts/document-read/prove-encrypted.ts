import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, reader, scratch } from './hardening-fixtures.ts'

const root = scratch('encrypted')
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
const md5 = (bytes: Buffer) => createHash('md5').update(bytes).digest()
const padding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex')
const pad = (s: string) => Buffer.concat([Buffer.from(s), padding]).subarray(0, 32)
function rc4(key: Buffer, bytes: Buffer): Buffer {
  const state = Array.from({ length: 256 }, (_, i) => i)
  let j = 0
  for (let i = 0; i < 256; i++) { j = (j + state[i]! + key[i % key.length]!) % 256; [state[i], state[j]] = [state[j]!, state[i]!] }
  let i = 0; j = 0
  return Buffer.from([...bytes].map(b => { i = (i + 1) % 256; j = (j + state[i]!) % 256; [state[i], state[j]] = [state[j]!, state[i]!]; return b ^ state[(state[i]! + state[j]!) % 256]! }))
}
function encrypted(user: string): Buffer {
  const id = md5(Buffer.from('document encryption fixture')), permissions = Buffer.alloc(4)
  permissions.writeInt32LE(-4)
  const owner = rc4(md5(pad('owner secret')).subarray(0, 5), pad(user))
  const key = md5(Buffer.concat([pad(user), owner, permissions, id])).subarray(0, 5)
  const u = rc4(key, padding)
  const stream = rc4(md5(Buffer.concat([key, Buffer.from([4, 0, 0, 0, 0])])).subarray(0, 10), Buffer.from('BT /F1 12 Tf 40 700 Td (Private text must not leak) Tj ET'))
  const objects = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), Buffer.from('<< /Type /Pages /Count 1 /Kids [5 0 R] >>'), Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'), Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from('\nendstream')]), Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>'), Buffer.from(`<< /Filter /Standard /V 1 /R 2 /O <${owner.toString('hex')}> /U <${u.toString('hex')}> /P -4 >>`)]
  const parts = [Buffer.from('%PDF-1.7\n')], offsets: number[] = []
  let size = parts[0]!.length
  for (const [i, object] of objects.entries()) { offsets.push(size); const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]); parts.push(part); size += part.length }
  parts.push(Buffer.from(`xref\n0 7\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>\nstartxref\n${size}\n%%EOF\n`))
  return Buffer.concat(parts)
}
try {
  const { read, healthy, context } = await reader(root)
  const { DocumentTool } = await import('../../src/tools/DocumentTool/DocumentTool.ts')
  const failures: string[] = []
  for (const user of ['', 'reader secret']) {
    const name = user ? 'user-password.pdf' : 'owner-password.pdf', path = join(root, name)
    writeFileSync(path, encrypted(user))
    for (const [road, run] of [
      ['Read', () => read(path)],
      ['inspect', () => DocumentTool.call({ op: 'inspect', source: path }, context, undefined as any, { uuid: crypto.randomUUID() } as any)],
      ['convert', () => DocumentTool.call({ op: 'convert', source: path, output: join(root, `${name}.pdf`), renderer: 'plain' }, context, undefined as any, { uuid: crypto.randomUUID() } as any)],
    ] as const) {
      let message = ''
      try { message = `RETURNED ${JSON.stringify(await run())}` } catch (error) { message = (error as Error).message }
      console.log(`${road} ${name}: ${message}`)
      if (!message.includes(name) || !/PDF is encrypted/.test(message) || !/unencrypted copy/i.test(message) || /RETURNED|Private text|\n\s*at /.test(message)) failures.push(`${road} ${name}`)
      await healthy()
    }
  }
  assert.deepEqual(failures, [])
  console.log('PASS owner-only and user-password PDFs refuse without partial text; Read, inspect, convert and same-session health')
} finally { cleanup(root) }
