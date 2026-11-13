import { basename, join, sep } from 'path'

import type { FrontmatterData } from '../../../utils/frontmatterParser.js'
import type { InstructionConvention, InstructionRuleFormat, InstructionRuleReading } from '../contracts.js'
import { isProjectInstructionExcluded } from '../nativeSource.js'

type SharedFormat = {
  id: string
  label: string
  guides?: readonly string[]
  locals?: readonly string[]
  ruleSources?: readonly string[]
  rules?: InstructionRuleFormat
  nearestOnly?: boolean
}

const under = (dir: string, relative: string): string => join(dir, ...relative.split('/'))
const spelled = (relative: string): string => relative.split('/').join(sep)

function folderHolding(filePath: string, relative: string): string | null {
  const ending = `${sep}${spelled(relative)}`
  return filePath.endsWith(ending) ? filePath.slice(0, -ending.length) : null
}

function folderAbove(filePath: string, relative: string): string | null {
  const at = filePath.indexOf(`${sep}${spelled(relative)}${sep}`)
  return at === -1 ? null : filePath.slice(0, at)
}

export function sharedFormat({ id, label, guides = [], locals = [], ruleSources = [], rules, nearestOnly }: SharedFormat): InstructionConvention {
  const ownerOf = (source: string): string | null => {
    for (const relative of ruleSources) {
      const folder = folderHolding(source, relative)
      if (folder !== null) return folder
    }
    return null
  }
  const ruleAt = (path: string): { owner: string; source: boolean } | null => {
    const owner = ownerOf(path)
    if (owner !== null) return { owner, source: true }
    if (rules === undefined || !rules.accepts(basename(path))) return null
    for (const relative of ruleSources) {
      const folder = folderAbove(path, relative)
      if (folder !== null) return { owner: folder, source: false }
    }
    return null
  }
  return {
    id,
    family: 'shared',
    fallback: true,
    label,
    belowHome: true,
    nearestOnly,
    projectDirFiles: dir => guides.map(guide => under(dir, guide)),
    projectRulesDirs: dir => ruleSources.map(source => under(dir, source)),
    localDirFile: dir => (locals.length > 0 ? under(dir, locals[0] as string) : null),
    localDirFiles: dir => locals.map(local => under(dir, local)),
    userFile: () => null,
    userRulesDir: () => null,
    managedFile: () => null,
    managedRulesDir: () => null,
    isExcluded: isProjectInstructionExcluded,
    instructionFileNames: [],
    rulesPathMarkers: [],
    rules,
    ruleAnchor: source => ownerOf(source) ?? join(source, '..'),
    ruleAt,
    folderOf(filePath) {
      for (const guide of [...guides, ...locals]) {
        const folder = folderHolding(filePath, guide)
        if (folder !== null) return folder
      }
      return ruleAt(filePath)?.owner ?? null
    },
  }
}

function listedPatterns(raw: unknown): string[] {
  const listed = Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : typeof raw === 'string' ? [raw] : []
  const patterns: string[] = []
  for (const entry of listed) {
    let depth = 0
    let current = ''
    for (const char of entry) {
      if (char === '{') depth++
      else if (char === '}') depth = Math.max(0, depth - 1)
      if (char === ',' && depth === 0) {
        patterns.push(current)
        current = ''
      } else {
        current += char
      }
    }
    patterns.push(current)
  }
  return patterns
}

export function vendorPatterns(raw: unknown): string[] {
  return listedPatterns(raw)
    .map(pattern => pattern.trim().replace(/^\.?\//, ''))
    .filter(pattern => pattern !== '')
    .map(pattern => (pattern.endsWith('/') ? `${pattern}**` : pattern))
}

export function scopeOf(patterns: string[]): InstructionRuleReading {
  return patterns.every(pattern => pattern === '**' || pattern === '**/*') ? { kind: 'always' } : { kind: 'scoped', globs: patterns }
}

export function describedBy(frontmatter: FrontmatterData): string {
  return typeof frontmatter.description === 'string' ? frontmatter.description.trim() : ''
}

export function threeFields(frontmatter: FrontmatterData): InstructionRuleReading | null {
  if (frontmatter.alwaysApply === true) return { kind: 'always' }
  const patterns = vendorPatterns(frontmatter.globs)
  if (patterns.length > 0) return scopeOf(patterns)
  const description = describedBy(frontmatter)
  return description === '' ? null : { kind: 'offered', description }
}

export function triggered(frontmatter: FrontmatterData): InstructionRuleReading | null {
  const trigger = frontmatter.trigger
  if (trigger === undefined || trigger === null) return null
  if (trigger === 'always_on') return { kind: 'always' }
  if (trigger === 'manual') return { kind: 'manual' }
  if (trigger === 'glob') {
    const patterns = vendorPatterns(frontmatter.globs)
    return patterns.length > 0 ? scopeOf(patterns) : { kind: 'unsupported', detail: 'trigger: glob with no globs: the rule is not loaded' }
  }
  if (trigger === 'model_decision' || trigger === 'agent') {
    const description = describedBy(frontmatter)
    return description === ''
      ? { kind: 'unsupported', detail: `trigger: ${trigger} with no description: the rule is not loaded` }
      : { kind: 'offered', description }
  }
  return {
    kind: 'unsupported',
    detail: `trigger: ${String(trigger)} is not a word Mercury reads: the rule is not loaded`,
    row: `its trigger "${String(trigger)}" is not one Mercury reads`,
  }
}
