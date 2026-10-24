import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function trackedDocs(root: string): Set<string> | undefined {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '--', 'docs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, windowsHide: true })
    const names = new Set(out.split('\n').filter(line => /^docs\/[^/]+\.md$/.test(line)).map(line => line.slice('docs/'.length)))
    return names.size > 0 ? names : undefined
  } catch {
    return undefined
  }
}

export function bundledDocPages(): Record<string, string> {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const pages: Record<string, string> = { 'README.md': readFileSync(join(root, 'README.md'), 'utf8') }
  const docs = join(root, 'docs')
  const tracked = trackedDocs(root)
  for (const name of readdirSync(docs).sort()) {
    if (!name.endsWith('.md')) continue
    if (tracked !== undefined && !tracked.has(name)) continue
    pages[`docs/${name}`] = readFileSync(join(docs, name), 'utf8')
  }
  return pages
}
