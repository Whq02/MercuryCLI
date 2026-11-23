import { statSync } from 'node:fs'
import { patternLanguageForFile, type PolyglotLanguage } from '../../../../platform/grammars/grammarFacility.js'
import { discoverPolyglotFiles } from '../polyglotQuery.js'
import * as path from 'node:path'
import { astLanguageNames, isCarried, uncarriedRefusal, resolveAstLanguage } from './languages.js'

export interface AstScopeFile {
  abs: string
  rel: string
  lang: PolyglotLanguage
}

export interface AstScope {
  root: string
  target: string
  display: string
  singleFile: boolean
  files: AstScopeFile[]
  skippedNoGrammar: Array<[ext: string, count: number]>
  skippedUncarried: Array<[ext: string, count: number]>
  skippedDenied: number
  skippedUnreadable?: { count: number; firstPath: string; firstError: string }
  truncatedWalk: boolean
  glob?: string
  lang?: PolyglotLanguage
}

export interface AstRefusal {
  refused: string
}

export function isAstRefusal(value: unknown): value is AstRefusal {
  return typeof value === 'object' && value !== null && typeof (value as AstRefusal).refused === 'string'
}

function normaliseGlob(glob: string): string {
  const trimmed = glob.trim().replace(/^\.\//, '')
  if (trimmed === '') return trimmed
  return trimmed.includes('/') ? trimmed : `**/${trimmed}`
}

function expandGlobAlternatives(glob: string): string[] | AstRefusal {
  const pending = [glob]
  const expanded: string[] = []
  while (pending.length > 0) {
    const current = pending.pop()!
    let group: { start: number; end: number; parts: string[] } | undefined
    for (let start = 0; start < current.length && group === undefined; start++) {
      if (current[start] !== '{') continue
      let depth = 0
      let partStart = start + 1
      const parts: string[] = []
      for (let end = start + 1; end < current.length; end++) {
        if (current[end] === '{') depth++
        else if (current[end] === '}') {
          if (depth > 0) depth--
          else {
            if (parts.length > 0) {
              parts.push(current.slice(partStart, end))
              group = { start, end, parts }
            }
            break
          }
        } else if (current[end] === ',' && depth === 0) {
          parts.push(current.slice(partStart, end))
          partStart = end + 1
        }
      }
    }
    if (group === undefined) expanded.push(current)
    else {
      for (let i = group.parts.length - 1; i >= 0; i--) {
        pending.push(current.slice(0, group.start) + group.parts[i] + current.slice(group.end + 1))
      }
    }
    if (expanded.length + pending.length > 64) {
      return { refused: `glob "${glob}" expands to more than 64 alternatives — use fewer {a,b} lists or a broader glob.` }
    }
  }
  return expanded
}

export function resolveAstScope(opts: {
  path?: string
  glob?: string
  lang?: string
  cwd: string
  readable?: (abs: string, throughLink?: boolean) => boolean
  trackLinks?: boolean
}): AstScope | AstRefusal {
  let lang: PolyglotLanguage | undefined
  if (opts.lang !== undefined && opts.lang.trim() !== '') {
    const resolved = resolveAstLanguage(opts.lang)
    if (!resolved) {
      return {
        refused: `Unknown language "${opts.lang}". Supported languages: ${astLanguageNames().join(', ')}. Omit lang to detect the language per file from its extension.`,
      }
    }
    if (!isCarried(resolved)) return { refused: uncarriedRefusal(resolved, `lang "${opts.lang}"`) }
    lang = resolved
  }
  const target = path.resolve(opts.cwd, opts.path ?? '.')
  const display = opts.path === undefined || opts.path === '' ? '.' : opts.path
  let stat
  try {
    stat = statSync(target)
  } catch {
    return { refused: `Path does not exist: ${display} (resolved against ${opts.cwd}).` }
  }
  if (stat.isFile()) {
    const fileLang = lang ?? patternLanguageForFile(target)
    if (!fileLang) {
      const ext = path.extname(target) || '(no extension)'
      return {
        refused: `${display} has no grammar for its extension ${ext}, so it cannot be searched structurally. Supported languages: ${astLanguageNames().join(', ')}. Pass lang to force one when the extension is misleading.`,
      }
    }
    if (!isCarried(fileLang)) return { refused: uncarriedRefusal(fileLang, display) }
    if (opts.readable && !opts.readable(target)) {
      return { refused: `${display} is hidden by a read-deny permission rule.` }
    }
    return {
      root: path.dirname(target),
      target,
      display,
      singleFile: true,
      files: [{ abs: target, rel: path.basename(target), lang: fileLang }],
      skippedNoGrammar: [],
      skippedUncarried: [],
      skippedDenied: 0,
      truncatedWalk: false,
      ...(opts.glob !== undefined && { glob: opts.glob }),
      ...(lang !== undefined && { lang }),
    }
  }
  if (!stat.isDirectory()) {
    return { refused: `${display} is neither a file nor a directory.` }
  }
  const glob = opts.glob !== undefined && opts.glob.trim() !== '' ? opts.glob : undefined
  const alternatives = glob === undefined ? undefined : expandGlobAlternatives(glob)
  if (isAstRefusal(alternatives)) return alternatives
  const discovered = discoverPolyglotFiles(target, alternatives?.map(normaliseGlob), lang ?? null, opts.trackLinks)
  let skippedDenied = 0
  const uncarried = new Map<string, number>()
  const files: AstScopeFile[] = []
  for (const f of discovered.files) {
    const abs = path.join(target, f.rel)
    if (!isCarried(f.lang)) {
      const ext = path.extname(f.rel).toLowerCase() || path.basename(f.rel)
      uncarried.set(ext, (uncarried.get(ext) ?? 0) + 1)
      continue
    }
    if (opts.readable && !opts.readable(abs, f.throughLink)) {
      skippedDenied++
      continue
    }
    files.push({ abs, rel: f.rel, lang: f.lang })
  }
  const byCount = (a: [string, number], b: [string, number]): number => b[1] - a[1] || a[0].localeCompare(b[0])
  return {
    root: target,
    target,
    display,
    singleFile: false,
    files,
    skippedNoGrammar: [...discovered.skippedNoGrammar.entries()].sort(byCount),
    skippedUncarried: [...uncarried.entries()].sort(byCount),
    skippedDenied,
    ...(discovered.skippedUnreadable > 0 && discovered.firstUnreadable !== undefined
      ? {
          skippedUnreadable: {
            count: discovered.skippedUnreadable,
            firstPath: discovered.firstUnreadable.path,
            firstError: discovered.firstUnreadable.error,
          },
        }
      : {}),
    truncatedWalk: discovered.truncatedWalk,
    ...(glob !== undefined && { glob }),
    ...(lang !== undefined && { lang }),
  }
}

export function describeSkipped(skipped: ReadonlyArray<[string, number]>, cap = 6): string {
  if (skipped.length === 0) return ''
  const shown = skipped.slice(0, cap).map(([ext, n]) => `${ext} ×${n}`)
  const more = skipped.length > cap ? `, +${skipped.length - cap} more` : ''
  return `${shown.join(', ')}${more}`
}
