import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

export function readReleaseNoteParameters(text) {
  const header = /^# (\S+) — published (\S+)(?:\r?\n|$)/.exec(text)
  return { version: header ? `v${header[1]}` : null, releaseDate: header ? header[2] : null }
}

export function latestReleaseNote(rootDir) {
  const { rcompare, valid } = createRequire(import.meta.url)('semver')
  const dir = join(rootDir, 'docs', 'releases')
  const versions = readdirSync(dir).filter(name => name.endsWith('.md')).map(name => name.slice(0, -3)).filter(version => valid(version)).sort(rcompare)
  for (const version of versions) {
    const text = readFileSync(join(dir, `${version}.md`), 'utf8')
    if (text.startsWith(`# ${version} — queued\n`) || text.startsWith(`# ${version} — ready for the tag\n`)) continue
    return readReleaseNoteParameters(text).version === `v${version}` ? text : ''
  }
  return ''
}

export function parseIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const [y, m, d] = s.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d)
  const back = new Date(t)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null
  return t
}

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
