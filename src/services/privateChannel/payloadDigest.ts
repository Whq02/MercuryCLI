import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const sha256File = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

export class PayloadNameError extends Error {}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

function walkPayloadFiles(dir: string, base = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const rel = base ? `${base}/${name}` : name
    if (CONTROL_CHARACTER.test(name)) {
      throw new PayloadNameError(`a name in the payload holds a control character, so the digest cannot tell its files apart: ${JSON.stringify(rel).slice(0, 120)}`)
    }
    if (statSync(full).isDirectory()) out.push(...walkPayloadFiles(full, rel))
    else out.push(rel)
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export function payloadDigestOf(dir: string): string {
  const h = createHash('sha256')
  for (const rel of walkPayloadFiles(dir)) {
    if (rel === 'manifest.json') continue
    h.update(`${rel}\n${sha256File(join(dir, rel))}\n`)
  }
  return h.digest('hex')
}
