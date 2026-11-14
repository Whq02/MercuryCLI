import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import * as path from 'node:path'
import {
  loadGrammarEngine,
  parsePolyglot,
  patternLanguageForFile,
  type PolyglotLanguage,
} from './grammarFacility.js'
import {
  captureKeyOf,
  compilePatternRoot,
  findExactSpanNode,
  lacksOnlyACloser,
  metavarOutsideNodes,
  patternCandidates,
  splitDeclaration,
  standInCandidates,
  standsAsMember,
  type CompiledPattern,
} from './pattern.js'
import { normalizeFileGlobs, posixRelative } from './scanPaths.js'

const MAX_FILES_SCANNED = 3000

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
  'vendor',
  'target',
])

interface IgnoreRules {
  dirs: Set<string>
  anchored: string[]
  suffixes: string[]
}

export function loadRootIgnoreRules(root: string): IgnoreRules {
  const rules: IgnoreRules = { dirs: new Set(), anchored: [], suffixes: [] }
  const file = path.join(root, '.gitignore')
  if (!existsSync(file)) return rules
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return rules
  }
  const lines = text.split('\n').slice(0, 500)
  if (lines.some(l => l.trim().startsWith('!'))) return rules
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('*.') && !line.slice(2).includes('*') && !line.includes('/')) {
      rules.suffixes.push(line.slice(1))
      continue
    }
    if (line.includes('*')) continue
    const trimmed = line.replace(/\/+$/, '')
    if (!trimmed) continue
    if (line.endsWith('/') && !trimmed.includes('/')) {
      rules.dirs.add(trimmed)
    } else {
      rules.anchored.push(trimmed.replace(/^\//, ''))
    }
  }
  return rules
}

function ignoredByRules(rules: IgnoreRules, rel: string, isDir: boolean, basename: string): boolean {
  if (isDir && rules.dirs.has(basename)) return true
  for (const suffix of rules.suffixes) {
    if (!isDir && rel.endsWith(suffix)) return true
  }
  for (const anchor of rules.anchored) {
    if (rel === anchor || rel.startsWith(`${anchor}/`)) return true
  }
  return false
}

function globToRegExp(glob: string): RegExp {
  const esc = (s: string): string => s.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '[^/]*')
  const parts = glob.split('**/').map(p => p.split('**').map(esc).join('.*'))
  return new RegExp(`^${parts.join('(?:.*/)?')}$`)
}

function matchesGlob(value: string, glob: string): boolean {
  if (!glob.includes('*')) return value === glob || value.startsWith(`${glob.replace(/\/$/, '')}/`)
  return globToRegExp(glob).test(value)
}

export function admitsPolyglotFile(rel: string, globs: readonly string[] | undefined): boolean {
  return globs === undefined || globs.some(g => matchesGlob(rel, g))
}

export function discoverPolyglotFiles(
  root: string,
  fileGlobs: string[] | undefined,
  langFilter: PolyglotLanguage | null,
  trackLinks = false,
): {
  files: Array<{ rel: string; lang: PolyglotLanguage; throughLink?: boolean }>
  scanned: number
  skippedUnsupported: number
  truncatedWalk: boolean
  skippedNoGrammar: Map<string, number>
} {
  const rules = loadRootIgnoreRules(root)
  const files: Array<{ rel: string; lang: PolyglotLanguage; throughLink?: boolean }> = []
  const skippedNoGrammar = new Map<string, number>()
  let scanned = 0
  let skippedUnsupported = 0
  let truncatedWalk = false
  const globs = normalizeFileGlobs(fileGlobs)

  let rootLinked = false
  if (trackLinks) {
    try {
      const resolved = realpathSync(root)
      rootLinked = process.platform === 'win32' ? resolved.toLowerCase() !== root.toLowerCase() : resolved !== root
    } catch {
    }
  }

  function walk(dir: string, throughLink: boolean): void {
    if (truncatedWalk) return
    let entries: string[]
    try {
      entries = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncatedWalk) return
      if (entry.startsWith('.')) continue
      const full = path.join(dir, entry)
      const rel = posixRelative(root, full)
      let stat
      let linked = throughLink
      try {
        if (trackLinks) {
          const entryStat = lstatSync(full)
          linked ||= entryStat.isSymbolicLink()
          stat = entryStat.isSymbolicLink() ? statSync(full) : entryStat
        } else stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue
        if (ignoredByRules(rules, rel, true, entry)) continue
        walk(full, linked)
      } else if (stat.isFile()) {
        scanned++
        if (scanned > MAX_FILES_SCANNED) {
          truncatedWalk = true
          return
        }
        if (ignoredByRules(rules, rel, false, entry)) continue
        if (!admitsPolyglotFile(rel, globs)) continue
        const lang = patternLanguageForFile(entry)
        if (!lang) {
          const ext = path.extname(entry).toLowerCase() || entry
          skippedNoGrammar.set(ext, (skippedNoGrammar.get(ext) ?? 0) + 1)
          continue
        }
        if (langFilter && lang.name !== langFilter.name) {
          skippedUnsupported++
          continue
        }
        files.push({ rel, lang, ...(trackLinks && { throughLink: linked }) })
      }
    }
  }
  walk(root, rootLinked)
  files.sort((a, b) => a.rel.localeCompare(b.rel))
  return { files, scanned, skippedUnsupported, truncatedWalk, skippedNoGrammar }
}

export type PatternRefusal = { state: 'refused'; note: string; textOnly?: boolean }

export async function compileFor(
  engine: Awaited<ReturnType<typeof loadGrammarEngine>> & { state: 'ok' },
  lang: PolyglotLanguage,
  encoded: string,
  cache: Map<string, { pattern: CompiledPattern; hold: { delete(): void } } | PatternRefusal>,
): Promise<{ pattern: CompiledPattern; hold: { delete(): void } } | PatternRefusal> {
  const cached = cache.get(lang.name)
  if (cached) return cached

  let recovery: { pattern: CompiledPattern; hold: { delete(): void } } | null = null
  let firstError: string | null = null
  let textOnly: string | null = null
  let split: string | null = null
  const candidates = patternCandidates(lang.name, encoded)

  const stoodIn = async (candidate: (typeof candidates)[number], read: string | null): Promise<{ pattern: CompiledPattern; hold: { delete(): void } } | null> => {
    for (const stood of standInCandidates(lang.name, candidate)) {
      const parsed = await parsePolyglot(engine, lang, stood.text)
      if ('state' in parsed) return null
      const node = parsed.parseErrors.length === 0 ? findExactSpanNode(parsed.tree.rootNode, stood.offset, stood.offset + stood.length, stood.text) : null
      const halves = node === null ? null : splitDeclaration(lang.name, node)
      if (halves?.says) split ??= halves.says
      const members = node === null ? [] : stood.stood!.map(member => standsAsMember(node, member))
      if (!node || node.parent === null || (read !== null && read !== node.type) || halves !== null || members.includes(null) || metavarOutsideNodes(node, stood.text, stood.offset, stood.offset + stood.length, stood.tagMetavars, stood.standIn)) {
        parsed.tree.delete()
        continue
      }
      const detached = Object.fromEntries(stood.stood!.flatMap((member, i) => (members[i] === 'detached' ? [[captureKeyOf(member.mark), stood.text[member.ended - 1]!]] : [])))
      return { pattern: { ...compilePatternRoot(node, stood.tagMetavars, stood.standIn, Object.keys(detached).length > 0 ? detached : undefined), ...(stood.spansTerminator && { spansTerminator: true }) }, hold: parsed.tree }
    }
    return null
  }

  for (const candidate of candidates) {
    const parsed = await parsePolyglot(engine, lang, candidate.text)
    if ('state' in parsed) {
      const refusal = { state: 'refused' as const, note: parsed.note }
      cache.set(lang.name, refusal)
      if (recovery) recovery.hold.delete()
      return refusal
    }
    const node = findExactSpanNode(parsed.tree.rootNode, candidate.offset, candidate.offset + candidate.length, candidate.text)
    if (parsed.parseErrors.length > 0) {
      const stood = await stoodIn(candidate, node !== null && node.parent !== null && lacksOnlyACloser(parsed.tree.rootNode, candidate.offset + candidate.length) ? node.type : null)
      if (stood) {
        parsed.tree.delete()
        if (recovery) recovery.hold.delete()
        cache.set(lang.name, stood)
        return stood
      }
    }
    if (!node) {
      firstError ??= parsed.parseErrors[0] ?? 'no single node spans the pattern'
      parsed.tree.delete()
      continue
    }
    const halves = splitDeclaration(lang.name, node)
    if (halves !== null) {
      if (halves.says === null) firstError ??= parsed.parseErrors[0] ?? 'no single node spans the pattern'
      else split ??= halves.says
      parsed.tree.delete()
      continue
    }
    if (lang.patternOnly) {
      const outside = metavarOutsideNodes(node, candidate.text, candidate.offset, candidate.offset + candidate.length, candidate.tagMetavars)
      if (outside) {
        textOnly ??= `${outside} is text there, not a node`
        parsed.tree.delete()
        continue
      }
    }
    if (parsed.parseErrors.length === 0) {
      if (recovery) recovery.hold.delete()
      const compiled = { pattern: { ...compilePatternRoot(node, candidate.tagMetavars), ...(candidate.spansTerminator && { spansTerminator: true }) }, hold: parsed.tree }
      cache.set(lang.name, compiled)
      return compiled
    }
    firstError ??= parsed.parseErrors[0]!
    if (!recovery && !node.hasError) {
      recovery = { pattern: compilePatternRoot(node, candidate.tagMetavars), hold: parsed.tree }
      continue
    }
    parsed.tree.delete()
  }

  if (recovery) {
    cache.set(lang.name, recovery)
    return recovery
  }
  const refusal: PatternRefusal = {
    state: 'refused' as const,
    note: `the pattern does not parse as ${lang.name} (${split ?? firstError ?? textOnly ?? 'no parse'})`,
    ...(split === null && firstError === null && textOnly !== null && { textOnly: true }),
  }
  cache.set(lang.name, refusal)
  return refusal
}
