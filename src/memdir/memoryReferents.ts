import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { getFlagSpec } from '../substrate/flagRegistry.js'

export const REFERENT_CAP = 8

export type MemoryReferent =
  | { kind: 'path'; token: string; resolved: string }
  | { kind: 'flag'; token: string }

export interface ReferentVerdict {
  checked: MemoryReferent[]
  missing: MemoryReferent[]
}

const PATH_RE = /(?:^|[\s`"'(\[=])((?:\.{1,2}\/|\/)?(?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]{1,8})(?=[:\s`"')\],.]|$)/g

const FLAG_RE = /\bMERCURY_[A-Z0-9_]{2,}\b/g

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
  projectRoot: string
  fileExists?: (absolutePath: string) => boolean
  flagRegistered?: (env: string) => boolean
}

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

export function referentNote(verdict: ReferentVerdict): string {
  if (verdict.missing.length === 0) return ''
  const parts = verdict.missing.map(ref =>
    ref.kind === 'path'
      ? `\`${ref.token}\` no longer exists at that path`
      : `\`${ref.token}\` is not a registered flag in this build`,
  )
  return `\n\n> Referent check: ${parts.join('; ')}. This memory describes a world that has moved — verify against the present tree before leaning on it.`
}
