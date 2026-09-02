import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function releaseNotesFor(version, rootDir) {
  const src = readFileSync(join(rootDir, 'src', 'constants', 'changelog.ts'), 'utf8')
  const lines = src.split('\n')
  const start = lines.findIndex(l => l.trim() === `## ${version}`)
  if (start < 0) return undefined
  const rest = lines.slice(start + 1)
  const endRel = rest.findIndex(l => l.startsWith('## ') || l.startsWith('`'))
  const body = (endRel < 0 ? rest : rest.slice(0, endRel)).join('\n').trim()
  if (!body) return undefined
  return `# Mercury ${version}\n\n${body}\n`
}

const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) : undefined
if (invokedPath && invokedPath === process.argv[1]) {
  const version = (process.argv[2] ?? '').replace(/^v/, '')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const notes = version ? releaseNotesFor(version, root) : undefined
  if (!notes) {
    console.error(`no ## ${version || '<version>'} section in src/constants/changelog.ts`)
    process.exit(1)
  }
  process.stdout.write(notes)
}
