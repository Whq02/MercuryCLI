import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { rcompare, valid } from 'semver'
import { DOC_RELEASE_DELTAS, EARLY_DOC_RELEASES, PRE_DOC_RELEASES } from './changelogArchive.js'

function parseHistoricalSections(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const section of text.split(/^## /m).slice(1)) {
    const lines = section.split('\n')
    const version = (lines[0] ?? '').trim()
    if (!version) continue
    const notes = lines
      .slice(1)
      .filter(line => line.startsWith('- '))
      .map(line => line.slice(2).trim())
      .filter(note => note !== '')
    if (notes.length > 0) out[version] = notes
  }
  return out
}

function applyHistoricalDocDelta(version: string, bullets: string[]): string[] {
  const delta = DOC_RELEASE_DELTAS[version]
  if (!delta) return bullets
  const swap = delta.replace
  const next = swap ? bullets.map(bullet => bullet.replace(swap[0], swap[1])) : [...bullets]
  if (delta.insert) next.splice(delta.insert[0], 0, delta.insert[1])
  return [...(delta.first === undefined ? [] : [delta.first]), ...next, ...(delta.last ?? [])]
}

function extractReleaseDocBullets(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(line => line.trim() === '## What changed')
  if (start < 0) return []
  const bullets: string[] = []
  let current: string | null = null
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
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

function isQueuedReleaseDoc(version: string, text: string): boolean {
  const firstLine = text.replace(/\r\n/g, '\n').split('\n', 1)[0] ?? ''
  return firstLine === `# ${version} — queued`
}

function defaultRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

export function buildMercuryChangelog(rootDir: string = defaultRoot()): string {
  const dir = join(rootDir, 'docs', 'releases')
  if (!existsSync(dir)) return ''
  const historicalReleases: Readonly<Record<string, string[]>> = {
    ...parseHistoricalSections(EARLY_DOC_RELEASES),
    ...parseHistoricalSections(PRE_DOC_RELEASES),
  }
  const versions = readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .map(name => name.slice(0, -3))
    .filter(version => valid(version) !== null)
    .sort(rcompare)
  const sections: string[] = []
  for (const version of versions) {
    const text = readFileSync(join(dir, `${version}.md`), 'utf8')
    if (isQueuedReleaseDoc(version, text)) continue
    const historical = historicalReleases[version]
    const bullets = historical ?? applyHistoricalDocDelta(version, extractReleaseDocBullets(text))
    if (bullets.length === 0) continue
    sections.push(`## ${version}\n${bullets.map(note => `- ${note}`).join('\n')}`)
  }
  if (sections.length === 0) return ''
  return `# Mercury changelog\n\n${sections.join('\n\n')}\n`
}

let changelogMemo: string | undefined

export function getMercuryChangelog(): string {
  if (changelogMemo !== undefined) return changelogMemo
  if (typeof MERCURY_CHANGELOG_PACKED === 'string') {
    changelogMemo = gunzipSync(Buffer.from(MERCURY_CHANGELOG_PACKED, 'base64')).toString('utf8')
  } else {
    changelogMemo = buildMercuryChangelog()
  }
  return changelogMemo
}
