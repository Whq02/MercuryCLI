import { readFile, writeFile, unlink, access, mkdir, readdir } from 'fs/promises'
import { renameWithWin32Retry } from '../substrate/durablePublish.js'
import { join } from 'path'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { ENTRYPOINT_NAME, serializeIndexUpdate, detectSecrets, capIndexLine } from './experienceCards.js'
import { getAutoMemPath } from './paths.js'
import { getScribeMemPath, getTeamMemPath } from './teamMemPaths.js'
import { cardPromoteRungateEnabled, runPromoteRungate } from './promoteRungate.js'

export type PromoteTarget = 'private' | 'team'

export type PromoteResult =
  | { ok: true; from: string; to: string; indexUpdated: boolean; approvedFlipped: boolean }
  | { ok: false; reason: 'not-found' | 'target-exists' | 'secret-bearing' | 'rungate-red' }

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

function noTrailingSep(dir: string): string {
  return dir.replace(/[/\\]+$/, '')
}

function flipApprovedInFrontmatter(markdown: string): { text: string; flipped: boolean } {
  const fmMatch = markdown.match(/^---\n[\s\S]*?\n---/)
  if (!fmMatch) return { text: markdown, flipped: false }
  const fm = fmMatch[0]
  if (!/\n\s*approved:\s*false\b/.test(fm)) return { text: markdown, flipped: false }
  const newFm = fm.replace(/(\n\s*approved:\s*)false\b/, `$1true`)
  return { text: markdown.replace(fm, newFm), flipped: true }
}

export async function promoteScribeCandidate(
  filename: string,
  target: PromoteTarget = 'private',
  opts: { scribeDir?: string; rootDir?: string; teamDir?: string } = {},
): Promise<PromoteResult> {
  const scribeDir = opts.scribeDir ?? noTrailingSep(getScribeMemPath())
  const destDir =
    target === 'team'
      ? opts.teamDir ?? noTrailingSep(getTeamMemPath())
      : opts.rootDir ?? noTrailingSep(getAutoMemPath())

  const src = join(scribeDir, filename)
  const dest = join(destDir, filename)

  if (!(await exists(src))) return { ok: false, reason: 'not-found' }
  if (await exists(dest)) return { ok: false, reason: 'target-exists' }

  const content = await readFile(src, 'utf-8')
  if (detectSecrets(content).length > 0) return { ok: false, reason: 'secret-bearing' }
  if (cardPromoteRungateEnabled()) {
    const gate = runPromoteRungate()
    if (!gate.pass) return { ok: false, reason: 'rungate-red' }
  }
  const flip = flipApprovedInFrontmatter(content)
  const promoted = flip.flipped ? flip.text : null
  const approvedFlipped = flip.flipped

  if (promoted !== null) {
    await writeFile(dest, promoted, 'utf-8')
    await unlink(src)
  } else {
    await renameWithWin32Retry(src, dest)
  }

  const { frontmatter } = parseFrontmatter(promoted ?? content, dest)
  const title = (frontmatter.name as string) || filename.replace(/\.md$/, '')
  const description = (frontmatter.description as string) || 'promoted from scribe scope'
  const indexLine = capIndexLine(`- [${title}](${filename}) — ${description}`)
  const indexUpdated = await serializeIndexUpdate(
    join(destDir, ENTRYPOINT_NAME),
    existing => {
      if (existing.includes(`](${filename})`)) return null
      const baseText = existing.trimEnd()
      return baseText
        ? `${baseText}\n${indexLine}\n`
        : `# Memory index\n\n${indexLine}\n`
    },
  )

  return { ok: true, from: src, to: dest, indexUpdated, approvedFlipped }
}


export type ScribeCandidateListing = {
  file: string
  name: string
  title: string
  description: string
}

export async function listScribeCandidates(
  scribeDir: string = noTrailingSep(getScribeMemPath()),
): Promise<ScribeCandidateListing[]> {
  let files: string[]
  try {
    files = await readdir(scribeDir)
  } catch {
    return []
  }
  const out: ScribeCandidateListing[] = []
  for (const f of files) {
    if (!f.endsWith('.md') || f === ENTRYPOINT_NAME) continue
    let md: string
    try {
      md = await readFile(join(scribeDir, f), 'utf-8')
    } catch {
      continue
    }
    try {
      const { frontmatter } = parseFrontmatter(md, join(scribeDir, f))
      const fm = frontmatter as Record<string, unknown>
      const name = typeof fm['name'] === 'string' ? (fm['name'] as string) : f.replace(/\.md$/, '')
      const description = typeof fm['description'] === 'string' ? (fm['description'] as string).trim() : ''
      out.push({
        file: f,
        name,
        title: description || name,
        description: description || 'staged scribe candidate (unratified)',
      })
    } catch {
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}


export const SCRIBE_NOTE_MAX_CHARS = 1200

export type StageResult =
  | { ok: true; path: string; bytes: number; truncated: boolean }
  | { ok: false; reason: 'empty' | 'secret' }

export function scribeNoteFilename(name: string): string {
  const slug =
    name
      .replace(/\.md$/i, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'note'
  return `${slug}.md`
}

export function capScribeNote(body: string): { text: string; truncated: boolean } {
  const trimmed = body.trim()
  if (trimmed.length <= SCRIBE_NOTE_MAX_CHARS) return { text: trimmed, truncated: false }
  return {
    text: trimmed.slice(0, SCRIBE_NOTE_MAX_CHARS).trimEnd() + '\n\n…(truncated — the scribe scope stays compact)',
    truncated: true,
  }
}

export async function stageScribeNote(
  name: string,
  body: string,
  opts: { description?: string; scribeDir?: string } = {},
): Promise<StageResult> {
  const trimmed = body.trim()
  if (!trimmed) return { ok: false, reason: 'empty' }
  if (detectSecrets(trimmed).length > 0) return { ok: false, reason: 'secret' }

  const { text, truncated } = capScribeNote(trimmed)
  const file = scribeNoteFilename(name)
  const slug = file.replace(/\.md$/, '')
  const dir = noTrailingSep(opts.scribeDir ?? getScribeMemPath())
  await mkdir(dir, { recursive: true })

  const doc = [
    '---',
    `name: ${slug}`,
    `description: ${(opts.description || 'scribe session note (unratified candidate)').replace(/\n/g, ' ')}`,
    'metadata:',
    '  type: scribe-candidate',
    '  approved: false',
    '---',
    '',
    text,
    '',
  ].join('\n')

  const path = join(dir, file)
  await writeFile(path, doc, 'utf-8')
  return { ok: true, path, bytes: Buffer.byteLength(doc, 'utf-8'), truncated }
}
