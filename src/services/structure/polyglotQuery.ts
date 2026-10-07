import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import {
  languageForFile,
  loadGrammarEngine,
  parsePolyglot,
  type PolyglotLanguage,
} from './grammarFacility.js'
import {
  compilePatternRoot,
  findExactSpanNode,
  patternCandidates,
  type CompiledPattern,
} from './pattern.js'

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

export function discoverPolyglotFiles(
  root: string,
  fileGlobs: string[] | undefined,
  langFilter: PolyglotLanguage | null,
): {
  files: Array<{ rel: string; lang: PolyglotLanguage }>
  scanned: number
  skippedUnsupported: number
  truncatedWalk: boolean
  skippedNoGrammar: Map<string, number>
} {
  const rules = loadRootIgnoreRules(root)
  const files: Array<{ rel: string; lang: PolyglotLanguage }> = []
  const skippedNoGrammar = new Map<string, number>()
  let scanned = 0
  let skippedUnsupported = 0
  let truncatedWalk = false
  const globs = fileGlobs?.map(g => g.replace(/^\.\//, ''))

  function walk(dir: string): void {
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
      const rel = path.relative(root, full)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue
        if (ignoredByRules(rules, rel, true, entry)) continue
        walk(full)
      } else if (stat.isFile()) {
        scanned++
        if (scanned > MAX_FILES_SCANNED) {
          truncatedWalk = true
          return
        }
        if (ignoredByRules(rules, rel, false, entry)) continue
        if (globs && !globs.some(g => matchesGlob(rel, g))) continue
        const lang = languageForFile(entry)
        if (!lang) {
          const ext = path.extname(entry).toLowerCase() || entry
          skippedNoGrammar.set(ext, (skippedNoGrammar.get(ext) ?? 0) + 1)
          continue
        }
        if (langFilter && lang.name !== langFilter.name) {
          skippedUnsupported++
          continue
        }
        files.push({ rel, lang })
      }
    }
  }
  walk(root)
  files.sort((a, b) => a.rel.localeCompare(b.rel))
  return { files, scanned, skippedUnsupported, truncatedWalk, skippedNoGrammar }
}

export async function compileFor(
  engine: Awaited<ReturnType<typeof loadGrammarEngine>> & { state: 'ok' },
  lang: PolyglotLanguage,
  encoded: string,
  cache: Map<string, { pattern: CompiledPattern; hold: { delete(): void } } | { state: 'refused'; note: string }>,
): Promise<{ pattern: CompiledPattern; hold: { delete(): void } } | { state: 'refused'; note: string }> {
  const cached = cache.get(lang.name)
  if (cached) return cached

  let recovery: { pattern: CompiledPattern; hold: { delete(): void } } | null = null
  let firstError: string | null = null

  for (const candidate of patternCandidates(lang.name, encoded)) {
    const parsed = await parsePolyglot(engine, lang, candidate.text)
    if ('state' in parsed) {
      const refusal = { state: 'refused' as const, note: parsed.note }
      cache.set(lang.name, refusal)
      if (recovery) recovery.hold.delete()
      return refusal
    }
    const node = findExactSpanNode(parsed.tree.rootNode, candidate.offset, candidate.offset + candidate.length, candidate.text)
    if (!node) {
      firstError ??= parsed.parseErrors[0] ?? 'no single node spans the pattern'
      parsed.tree.delete()
      continue
    }
    if (parsed.parseErrors.length === 0) {
      if (recovery) recovery.hold.delete()
      const compiled = { pattern: compilePatternRoot(node), hold: parsed.tree }
      cache.set(lang.name, compiled)
      return compiled
    }
    firstError ??= parsed.parseErrors[0]!
    if (!recovery && !node.hasError) {
      recovery = { pattern: compilePatternRoot(node), hold: parsed.tree }
      continue
    }
    parsed.tree.delete()
  }

  if (recovery) {
    cache.set(lang.name, recovery)
    return recovery
  }
  const refusal = {
    state: 'refused' as const,
    note: `the pattern does not parse as ${lang.name} (${firstError ?? 'no parse'})`,
  }
  cache.set(lang.name, refusal)
  return refusal
}
