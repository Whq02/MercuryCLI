import { existsSync, readFileSync, readdirSync } from 'node:fs'
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

function extractReleaseDocBullets(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(line => line.trim() === '## What changed')
  if (start < 0) return []
  const bullets = []
  let current = null
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ') || line.startsWith('# ')) break
    if (line.startsWith('- ')) {
      if (current !== null) bullets.push(current)
      current = line.slice(2).trim()
    } else if (current !== null && /^\s+\S/.test(line)) {
      current = `${current} ${line.trim()}`
    } else if (line.trim() === '') {
      if (current !== null) {
        bullets.push(current)
        current = null
      }
    }
  }
  if (current !== null) bullets.push(current)
  return bullets.filter(note => note !== '')
}

export function releaseNotesFor(version, rootDir) {
  const docPath = join(rootDir, 'docs', 'releases', `${version}.md`)
  if (!existsSync(docPath)) return undefined
  const bullets = extractReleaseDocBullets(readFileSync(docPath, 'utf8'))
  if (bullets.length === 0) return undefined
  const body = bullets.map(bullet => `- ${bullet}`).join('\n')
  return `# Mercury ${version}\n\n${body}\n`
}

const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) : undefined
if (invokedPath && invokedPath === process.argv[1]) {
  const version = (process.argv[2] ?? '').replace(/^v/, '')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const notes = version ? releaseNotesFor(version, root) : undefined
  if (!notes) {
    console.error(`no ## What changed section in docs/releases/${version || '<version>'}.md`)
    process.exit(1)
  }
  process.stdout.write(notes)
}
