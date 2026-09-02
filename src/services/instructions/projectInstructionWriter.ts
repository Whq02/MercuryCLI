import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { findGitRoot } from '../../utils/git.js'
import { pathInWorkingPath } from '../../utils/permissions/filesystem.js'
import { mercuryNativeConvention } from './adapters/mercuryNative.js'
import { clearInstructionFileCaches } from './engine.js'
import { parseInstructionFileContent } from './sourceText.js'

const MAX_POINTER_DEPTH = 5

export const POINTER_PROSE_MAX_LINES = 6

export type CaptureResult =
  | { action: 'recorded'; path: string; created: boolean }
  | { action: 'updated'; path: string }
  | { action: 'already-recorded'; path: string }
  | { action: 'replace-miss'; path: string; searched: string[] }
  | { action: 'invalid'; reason: string }

export function projectInstructionRoot(cwd: string): string {
  return findGitRoot(cwd) ?? cwd
}

export function resolveProjectInstructionEntry(cwd: string): {
  path: string
  exists: boolean
} {
  const root = projectInstructionRoot(cwd)
  const dirs = root === cwd ? [root] : [root, cwd]
  for (const dir of dirs) {
    for (const candidate of mercuryNativeConvention.projectDirFiles(dir)) {
      if (existsSync(candidate)) return { path: candidate, exists: true }
    }
  }
  return { path: join(root, 'MERCURY.md'), exists: false }
}

type ParsedEstateFile = {
  path: string
  raw: string
  content: string
  includePaths: string[]
}

function readEstateFile(path: string): ParsedEstateFile | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const { info, includePaths, bareMentionPaths } = parseInstructionFileContent(raw, path, 'Project', path)
  if (info === null) return null
  return { path, raw, content: info.content, includePaths: [...includePaths, ...bareMentionPaths] }
}

export function proseLineCount(content: string): number {
  let count = 0
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (/^#{1,6}\s/.test(trimmed) || /^#{1,6}$/.test(trimmed)) continue
    const withoutImports = trimmed.replace(/(?:^|\s)@(?:[^\s\\]|\\ )+/g, '').trim()
    if (withoutImports === '') continue
    count++
  }
  return count
}

export function followPointerLaw(
  entryPath: string,
  root: string,
): { targetPath: string; chain: string[] } {
  const chain: string[] = [entryPath]
  const visited = new Set<string>([entryPath])
  let current = entryPath

  for (let depth = 0; depth < MAX_POINTER_DEPTH; depth++) {
    const parsed = readEstateFile(current)
    if (parsed === null) break
    if (proseLineCount(parsed.content) > POINTER_PROSE_MAX_LINES) break
    const next = parsed.includePaths.find(
      p => !visited.has(p) && pathInWorkingPath(p, root) && existsSync(p),
    )
    if (next === undefined) break
    visited.add(next)
    chain.push(next)
    current = next
  }

  return { targetPath: current, chain }
}

export function resolveCaptureTargetPath(cwd: string): string {
  const entry = resolveProjectInstructionEntry(cwd)
  if (!entry.exists) return entry.path
  return followPointerLaw(entry.path, projectInstructionRoot(cwd)).targetPath
}

function estateClosure(entryPath: string, root: string): ParsedEstateFile[] {
  const files: ParsedEstateFile[] = []
  const visited = new Set<string>()
  const queue: Array<{ path: string; depth: number }> = [
    { path: entryPath, depth: 0 },
  ]
  while (queue.length > 0) {
    const { path, depth } = queue.shift()!
    if (visited.has(path)) continue
    visited.add(path)
    const parsed = readEstateFile(path)
    if (parsed === null) continue
    files.push(parsed)
    if (depth + 1 >= MAX_POINTER_DEPTH) continue
    for (const include of parsed.includePaths) {
      if (pathInWorkingPath(include, root) && existsSync(include)) {
        queue.push({ path: include, depth: depth + 1 })
      }
    }
  }
  return files
}

function normalizeRuleLine(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/\s+/g, ' ')
    .replace(/\.$/, '')
    .toLowerCase()
}

function ruleAsLine(rule: string): string {
  return rule.replace(/\s+/g, ' ').trim()
}

const FRESH_ENTRY_HEADER =
  '# MERCURY.md\nStanding orders for the Mercury harness in this repository.\n'

export function appendRuleToContent(raw: string, rule: string): string {
  const trimmedEnd = raw.replace(/\s+$/, '')
  if (trimmedEnd === '') return `- ${rule}\n`
  const lastLine = trimmedEnd.slice(trimmedEnd.lastIndexOf('\n') + 1)
  const separator = /^\s*[-*]\s+/.test(lastLine) ? '\n' : '\n\n'
  return `${trimmedEnd}${separator}- ${rule}\n`
}

export function captureProjectInstruction(options: {
  cwd: string
  rule: string
  replaces?: string
}): CaptureResult {
  const rule = ruleAsLine(options.rule)
  if (rule === '') return { action: 'invalid', reason: 'an empty rule records nothing' }

  const root = projectInstructionRoot(options.cwd)
  const entry = resolveProjectInstructionEntry(options.cwd)

  if (!entry.exists) {
    if (options.replaces !== undefined) {
      return {
        action: 'replace-miss',
        path: entry.path,
        searched: [],
      }
    }
    mkdirSync(dirname(entry.path), { recursive: true })
    writeFileSync(entry.path, `${FRESH_ENTRY_HEADER}\n- ${rule}\n`, 'utf8')
    clearInstructionFileCaches()
    return { action: 'recorded', path: entry.path, created: true }
  }

  const closure = estateClosure(entry.path, root)

  if (options.replaces !== undefined) {
    const needle = options.replaces.trim()
    if (needle === '') return { action: 'invalid', reason: 'an empty replaces matches nothing' }
    for (const file of closure) {
      const lines = file.raw.split('\n')
      const index = lines.findIndex(l => l.includes(needle))
      if (index === -1) continue
      const marker = /^(\s*[-*]\s+)/.exec(lines[index]!)
      lines[index] = marker ? `${marker[1]}${rule}` : rule
      writeFileSync(file.path, lines.join('\n'), 'utf8')
      clearInstructionFileCaches()
      return { action: 'updated', path: file.path }
    }
    return {
      action: 'replace-miss',
      path: entry.path,
      searched: closure.map(f => f.path),
    }
  }

  const normalized = normalizeRuleLine(rule)
  for (const file of closure) {
    for (const line of file.content.split('\n')) {
      if (normalizeRuleLine(line) === normalized && normalized !== '') {
        return { action: 'already-recorded', path: file.path }
      }
    }
  }

  const { targetPath } = followPointerLaw(entry.path, root)
  const target = readEstateFile(targetPath)
  const currentRaw = target?.raw ?? ''
  writeFileSync(targetPath, appendRuleToContent(currentRaw, rule), 'utf8')
  clearInstructionFileCaches()
  return { action: 'recorded', path: targetPath, created: false }
}

export function describeCaptureResult(result: CaptureResult): string {
  switch (result.action) {
    case 'recorded':
      return result.created
        ? `Recorded in ${basename(result.path)} (born now) — ${result.path}`
        : `Recorded in ${basename(result.path)} — ${result.path}`
    case 'updated':
      return `Updated the existing rule in ${basename(result.path)} — ${result.path}`
    case 'already-recorded':
      return `Already recorded in ${basename(result.path)} — nothing written`
    case 'replace-miss':
      return `No line matching \`replaces\` found${result.searched.length > 0 ? ` in ${result.searched.map(p => basename(p)).join(', ')}` : ''} — nothing written; re-read the estate and retry`
    case 'invalid':
      return `Nothing recorded: ${result.reason}`
  }
}
