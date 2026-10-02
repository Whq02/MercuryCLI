import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function bundledDocPages(): Record<string, string> {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const pages: Record<string, string> = { 'README.md': readFileSync(join(root, 'README.md'), 'utf8') }
  const docs = join(root, 'docs')
  for (const name of readdirSync(docs).sort()) {
    if (name.endsWith('.md')) pages[`docs/${name}`] = readFileSync(join(docs, name), 'utf8')
  }
  return pages
}
