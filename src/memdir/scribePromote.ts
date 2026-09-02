/**
 * Scribe Mode "Amanuensis" — ratify-promote helper.
 *
 * A candidate staged in the `scribe/` scope is excluded from recall
 * (memoryScan.ts) until it is RATIFIED. Promotion is the ratify act: it moves
 * the candidate out of `scribe/` into the destination memory scope (root
 * "private" memory by default, or the `team` scope), adds a `MEMORY.md` pointer
 * via the SAME crash-safe serialized index writer the experience-card path uses,
 * and flips an `approved: false` candidate to `approved: true` (mirroring the
 * card lifecycle). It is ALWAYS programmatic / operator-invoked — never
 * automatic — and NON-DESTRUCTIVE: it refuses if a file of the same name already
 * exists at the destination (no clobber).
 *
 * Not gated: this is a deliberate steward action invoked only when scribe mode
 * is in use; it has no passive call-site, so there is no OFF behavior to keep
 * byte-identical.
 *
 * Runtime callers: the WRITE-IN (stageScribeNote) is wired agent-facing via the
 * RememberLesson tool's `scope: 'scribe'` route (tools/RememberLessonTool); the
 * ratify-OUT (promoteScribeCandidate) is operator-invoked via the `/scribe-promote`
 * command (components/ScribeCandidatesView.tsx → listScribeCandidates here, then
 * promoteScribeCandidate on the `p` key — mirroring how /cards ratifies experience
 * cards). Proofs live under scripts/scribe/: prove-scribe-memory.ts (stage→ratify
 * round-trip + the frontmatter flip + the tool route), prove-scribe-scope.ts (promote
 * move/index/non-clobber), prove-two-agent-memory.ts (the write floor); the operator
 * surface is wired by scripts/capabilities/prove-capability-wiring.ts. Run via
 * scripts/scribe/run-all.sh + scripts/capabilities/run-all.sh.
 */
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

/** Strip a trailing path separator (getScribeMemPath/getTeamMemPath append one). */
function noTrailingSep(dir: string): string {
  return dir.replace(/[/\\]+$/, '')
}

/**
 * Flip `approved: false` → `approved: true` ONLY inside the leading `---…---`
 * frontmatter block (mirrors promoteCardMarkdown in experienceCards.ts). Anchored +
 * newline-bounded so a note whose BODY prose contains 'approved: false' is never
 * corrupted, and so it tolerates both a top-level `approved:` and a nested
 * ` approved:` key (the scribe candidate nests it under `metadata:`). Returns the
 * rewritten markdown and whether anything actually flipped (flipped:false ⇒ no
 * frontmatter approved key ⇒ caller moves the file unchanged). Pure.
 */
function flipApprovedInFrontmatter(markdown: string): { text: string; flipped: boolean } {
  const fmMatch = markdown.match(/^---\n[\s\S]*?\n---/)
  if (!fmMatch) return { text: markdown, flipped: false }
  const fm = fmMatch[0]
  if (!/\n\s*approved:\s*false\b/.test(fm)) return { text: markdown, flipped: false }
  const newFm = fm.replace(/(\n\s*approved:\s*)false\b/, `$1true`)
  return { text: markdown.replace(fm, newFm), flipped: true }
}

/**
 * Ratify and promote one `scribe/` candidate into the destination scope.
 *
 * @param filename the candidate file name within `scribe/` (e.g. `cand.md`)
 * @param target 'private' (root auto-memory, default) or 'team'
 * @param opts dir overrides for testing; production uses the resolved scopes
 */
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
  // Non-destructive: never clobber an existing destination file.
  if (await exists(dest)) return { ok: false, reason: 'target-exists' }

  // Read the candidate; flip approved:false → approved:true (ratify lifecycle).
  // ONLY inside the leading frontmatter block — a whole-doc String.replace would
  // corrupt a note whose BODY prose contains 'approved: false' (and could ratify the
  // wrong line). Mirrors promoteCardMarkdown's anchored idiom in experienceCards.ts.
  const content = await readFile(src, 'utf-8')
  // re-scan for secrets BEFORE moving into recall-visible (and, for
  // target='team', SYNCED/shared) memory. Promotion is asymmetric with both card
  // paths (buildExperienceCard + renderExperienceCardForRecall both scan) — a
  // secret edited into a candidate AFTER it was staged would otherwise ratify
  // straight into recall. Refuse + leave the candidate in scribe scope.
  if (detectSecrets(content).length > 0) return { ok: false, reason: 'secret-bearing' }
  // MERCURY_CARD_PROMOTE_RUNGATE (opt-in): run the green-gate before ratifying —
  // refuse approved:true on a non-zero gate, exactly the flag-registry
  // contract. The guarded class is a severed wire
  // (machinery+flag+proofs with no caller); the
  // flag stays default-OFF ⇒ the
  // promote path spawns nothing unless the operator opted in.
  if (cardPromoteRungateEnabled()) {
    const gate = runPromoteRungate()
    if (!gate.pass) return { ok: false, reason: 'rungate-red' }
  }
  const flip = flipApprovedInFrontmatter(content)
  const promoted = flip.flipped ? flip.text : null
  const approvedFlipped = flip.flipped

  // Move: rename is the fast path; if we must rewrite the field, write-then-unlink.
  if (promoted !== null) {
    await writeFile(dest, promoted, 'utf-8')
    await unlink(src)
  } else {
    // Plain move, win32 bounded retry: AV scanning the fresh card
    // must not fail the promote.
    await renameWithWin32Retry(src, dest)
  }

  // Index the promoted memory in the destination MEMORY.md via the SAME
  // serialized, crash-safe writer the card path uses (no duplicate pointer).
  const { frontmatter } = parseFrontmatter(promoted ?? content, dest)
  const title = (frontmatter.name as string) || filename.replace(/\.md$/, '')
  const description = (frontmatter.description as string) || 'promoted from scribe scope'
  const indexLine = capIndexLine(`- [${title}](${filename}) — ${description}`)
  const indexUpdated = await serializeIndexUpdate(
    join(destDir, ENTRYPOINT_NAME),
    existing => {
      if (existing.includes(`](${filename})`)) return null // already indexed (link-anchored)
      const baseText = existing.trimEnd()
      return baseText
        ? `${baseText}\n${indexLine}\n`
        : `# Memory index\n\n${indexLine}\n`
    },
  )

  return { ok: true, from: src, to: dest, indexUpdated, approvedFlipped }
}

// ── Listing (the read counterpart that backs the /scribe-promote surface) ─────

/** One staged scribe candidate, ready for the ratify UI. `file` is the on-disk
 *  name (with .md) that promoteScribeCandidate takes; `title`/`description` come
 *  from the frontmatter (falling back to the slug). */
export type ScribeCandidateListing = {
  file: string
  name: string
  title: string
  description: string
}

/**
 * List the unratified candidates staged in the `scribe/` scope, newest-stable
 * order (by name). Mirrors listExperienceCards' robustness: a missing dir ⇒ [],
 * the MEMORY.md index + unparseable files are skipped, and any read error on one
 * file never aborts the listing. Pure read — never writes.
 */
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
      /* unparseable frontmatter — skip */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// ── Staging (the write counterpart to promote) ───────────────────────────────
// The operator's ask: a SEPARATE scribe memory, "maintained when activated… a
// truncated / efficient version to avoid poisoning memory." The `scribe/` scope
// already delivers the anti-poisoning half (recall-excluded, memoryScan.ts), and
// promote moves things OUT. This is the missing write IN: the Scribe stages a
// COMPACT session note as an unratified candidate. Three guarantees keep it from
// poisoning or bloating: (1) it lands in the recall-excluded `scribe/` scope, so
// it never silently steers a future turn; (2) it is hard-CAPPED so the scope stays
// a terse working memory, never a growing transcript; (3) it refuses secrets (the
// same floor as the experience-card write path). Idempotent by name — re-staging
// the same note OVERWRITES (maintenance), never appends.

/** Hard cap so the scribe scope stays a TRUNCATED working memory, not a transcript. */
export const SCRIBE_NOTE_MAX_CHARS = 1200

export type StageResult =
  | { ok: true; path: string; bytes: number; truncated: boolean }
  | { ok: false; reason: 'empty' | 'secret' }

/** Slugify a note name into a safe, stable `.md` filename (so re-staging overwrites). */
export function scribeNoteFilename(name: string): string {
  const slug =
    name
      .replace(/\.md$/i, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'note'
  return `${slug}.md`
}

/** Cap a note body to SCRIBE_NOTE_MAX_CHARS, marking the truncation honestly. Pure. */
export function capScribeNote(body: string): { text: string; truncated: boolean } {
  const trimmed = body.trim()
  if (trimmed.length <= SCRIBE_NOTE_MAX_CHARS) return { text: trimmed, truncated: false }
  return {
    text: trimmed.slice(0, SCRIBE_NOTE_MAX_CHARS).trimEnd() + '\n\n…(truncated — the scribe scope stays compact)',
    truncated: true,
  }
}

/**
 * Stage one COMPACT session note into the `scribe/` scope as an unratified
 * candidate (approved:false, so promoteScribeCandidate can later ratify it).
 * Overwrites a same-named note (maintenance, not accumulation). Refuses secrets +
 * empty bodies. NON-indexing: scribe candidates are deliberately excluded from
 * MEMORY.md / recall until promoted.
 */
export async function stageScribeNote(
  name: string,
  body: string,
  opts: { description?: string; scribeDir?: string } = {},
): Promise<StageResult> {
  const trimmed = body.trim()
  if (!trimmed) return { ok: false, reason: 'empty' }
  // Same floor as the experience-card write path — never stage a secret.
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
    // approved nests UNDER metadata: (a sibling of type) so the frontmatter is one
    // coherent block; the anchored ratify flip (flipApprovedInFrontmatter) handles
    // the nested indentation. scribe-candidate is a sibling of experience-card, so a
    // staged note is deliberately NOT recognized as a card by readCardMeta.
    '  approved: false',
    '---',
    '',
    text,
    '',
  ].join('\n')

  const path = join(dir, file)
  await writeFile(path, doc, 'utf-8') // overwrite = idempotent maintenance
  return { ok: true, path, bytes: Buffer.byteLength(doc, 'utf-8'), truncated }
}
