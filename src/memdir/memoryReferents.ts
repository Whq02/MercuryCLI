// ============================================================================
//  src/memdir/memoryReferents.ts — provenance-grade referent verification:
//  does the world a memory points at still exist?
//
//  A memory naming a file path or a registry flag is a claim about the
//  present tree, and the age caveat alone cannot catch a referent that
//  moved or died. This module extracts the CHECKABLE referents from a
//  memory's text and verifies each against its owning authority — paths
//  against the filesystem, MERCURY_* flags against the flag registry.
//  Precision over recall by construction: only tokens that parse as a real
//  path shape (a separator plus an extension) or a registered-flag shape
//  are checked; placeholders, URLs and glob patterns are skipped, so a
//  "missing" verdict is a real absence, never lexical noise. Bounded: the
//  first REFERENT_CAP distinct referents per text.
//
//  Consumers: recall surfacing (the referent note under a surfaced memory)
//  and the curation sweep (a broken-referent memory is a decay candidate).
// ============================================================================
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { getFlagSpec } from '../substrate/flagRegistry.js'

export const REFERENT_CAP = 8

export type MemoryReferent =
  | { kind: 'path'; token: string; resolved: string }
  | { kind: 'flag'; token: string }

export interface ReferentVerdict {
  /** Distinct referents actually checked (post-cap). */
  checked: MemoryReferent[]
  /** The subset whose authority answered "absent". */
  missing: MemoryReferent[]
}

// A path referent: at least one separator and a short extension — `src/x.ts`,
// `./scripts/run.sh`, `/abs/dir/file.md`, with an optional `:line` tail.
// Quotes/backticks/parens around it are stripped by the boundary groups.
const PATH_RE = /(?:^|[\s`"'(\[=])((?:\.{1,2}\/|\/)?(?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]{1,8})(?=[:\s`"')\],.]|$)/g

// A registry-flag referent. The registry owns the truth of what exists.
const FLAG_RE = /\bMERCURY_[A-Z0-9_]{2,}\b/g

/** Tokens that are templates, globs or remote — never checkable claims. */
function uncheckable(token: string): boolean {
  return (
    token.includes('{') ||
    token.includes('<') ||
    token.includes('*') ||
    token.includes('$') ||
    /^[a-z]+:\/\//i.test(token) ||
    token.startsWith('node_modules/')
  )
}

/** Extract the checkable referents from a memory's text, capped. */
export function extractMemoryReferents(text: string): MemoryReferent[] {
  const out: MemoryReferent[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(PATH_RE)) {
    const token = match[1]!
    if (uncheckable(token) || seen.has(token)) continue
    seen.add(token)
    out.push({ kind: 'path', token, resolved: token })
    if (out.length >= REFERENT_CAP) return out
  }
  for (const match of text.matchAll(FLAG_RE)) {
    const token = match[0]
    if (seen.has(token)) continue
    seen.add(token)
    out.push({ kind: 'flag', token })
    if (out.length >= REFERENT_CAP) return out
  }
  return out
}

export interface VerifyReferentOptions {
  /** The root relative paths resolve against (the project root in
   *  production; provers pass a scratch tree). */
  projectRoot: string
  /** Injectable probe for tests; defaults to the real filesystem. */
  fileExists?: (absolutePath: string) => boolean
  /** Injectable registry probe; defaults to the real flag registry. */
  flagRegistered?: (env: string) => boolean
}

/**
 * Verify a memory text's referents against the present world. Total: an
 * unreadable probe counts the referent as present (fail-open — a probe
 * error must never brand a memory stale).
 */
export function verifyMemoryReferents(text: string, options: VerifyReferentOptions): ReferentVerdict {
  const fileExists =
    options.fileExists ??
    ((p: string): boolean => {
      try {
        return existsSync(p)
      } catch {
        return true
      }
    })
  const flagRegistered = options.flagRegistered ?? ((env: string): boolean => getFlagSpec(env) !== undefined)
  const checked = extractMemoryReferents(text)
  const missing = checked.filter(ref => {
    // Fail OPEN around the probes themselves, injected ones included — a
    // probe error must never brand a memory stale.
    try {
      if (ref.kind === 'flag') return !flagRegistered(ref.token)
      const absolute = isAbsolute(ref.token) ? ref.token : join(options.projectRoot, ref.token)
      return !fileExists(absolute)
    } catch {
      return false
    }
  })
  return { checked, missing }
}

/**
 * The note a surfaced memory carries when referents are missing — empty
 * when everything checked out (silence is the honest default; a "verified"
 * badge would claim more than an existence probe knows). Rendered INTO the
 * surfaced content, never into the attachment header (that string is a
 * frozen cache contract).
 */
export function referentNote(verdict: ReferentVerdict): string {
  if (verdict.missing.length === 0) return ''
  const parts = verdict.missing.map(ref =>
    ref.kind === 'path'
      ? `\`${ref.token}\` no longer exists at that path`
      : `\`${ref.token}\` is not a registered flag in this build`,
  )
  return `\n\n> Referent check: ${parts.join('; ')}. This memory describes a world that has moved — verify against the present tree before leaning on it.`
}
