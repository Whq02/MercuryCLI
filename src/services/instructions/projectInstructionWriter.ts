import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { findGitRoot } from '../../utils/git.js'
import { pathInWorkingPath } from '../../utils/permissions/filesystem.js'
import { NATIVE_INSTRUCTION_FILE_NAMES, mercuryNativeConvention } from './nativeSource.js'
import { MAX_INCLUDE_DEPTH } from './discovery.js'
import { clearInstructionFileCaches } from './engine.js'
import { parseInstructionFileContent } from './sourceText.js'

const MAX_POINTER_DEPTH = MAX_INCLUDE_DEPTH

const POINTER_PROSE_MAX_LINES = 6

export type CaptureResult =
  | { action: 'recorded'; path: string; created: boolean }
  | { action: 'updated'; path: string }
  | { action: 'already-recorded'; path: string }
  | { action: 'replace-miss'; path: string; searched: string[] }
  | { action: 'invalid'; reason: string }

function projectInstructionRoot(cwd: string): string {
  return findGitRoot(cwd) ?? cwd
}

function resolveProjectInstructionEntry(cwd: string): {
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
  return { path: join(root, NATIVE_INSTRUCTION_FILE_NAMES[0]), exists: false }
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

function proseLineCount(content: string): number {
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

function appendRuleToContent(raw: string, rule: string): string {
  const trimmedEnd = raw.replace(/\s+$/, '')
  if (trimmedEnd === '') return `- ${rule}\n`
  const lastLine = trimmedEnd.slice(trimmedEnd.lastIndexOf('\n') + 1)
  const separator = /^\s*[-*]\s+/.test(lastLine) ? '\n' : '\n\n'
  return `${trimmedEnd}${separator}- ${rule}\n`
}

type CapturePlan =
  | { write: true; result: Extract<CaptureResult, { action: 'recorded' | 'updated' }>; path: string; before: string; after: string }
  | { write: false; result: Exclude<CaptureResult, { action: 'recorded' | 'updated' }> }

export function planProjectInstruction(options: {
  cwd: string
  rule: string
  replaces?: string
}): CapturePlan {
  const rule = ruleAsLine(options.rule)
  if (rule === '') return { write: false, result: { action: 'invalid', reason: 'an empty rule records nothing' } }

  const root = projectInstructionRoot(options.cwd)
  const entry = resolveProjectInstructionEntry(options.cwd)

  if (!entry.exists) {
    if (options.replaces !== undefined) {
      return { write: false, result: { action: 'replace-miss', path: entry.path, searched: [] } }
    }
    return {
      write: true,
      result: { action: 'recorded', path: entry.path, created: true },
      path: entry.path,
      before: '',
      after: `${FRESH_ENTRY_HEADER}\n- ${rule}\n`,
    }
  }

  const closure = estateClosure(entry.path, root)

  if (options.replaces !== undefined) {
    const needle = options.replaces.trim()
    if (needle === '') return { write: false, result: { action: 'invalid', reason: 'an empty replaces matches nothing' } }
    for (const file of closure) {
      const lines = file.raw.split('\n')
      const index = lines.findIndex(l => l.includes(needle))
      if (index === -1) continue
      const marker = /^(\s*[-*]\s+)/.exec(lines[index]!)
      lines[index] = marker ? `${marker[1]}${rule}` : rule
      return { write: true, result: { action: 'updated', path: file.path }, path: file.path, before: file.raw, after: lines.join('\n') }
    }
    return { write: false, result: { action: 'replace-miss', path: entry.path, searched: closure.map(f => f.path) } }
  }

  const normalized = normalizeRuleLine(rule)
  for (const file of closure) {
    for (const line of file.content.split('\n')) {
      if (normalizeRuleLine(line) === normalized && normalized !== '') {
        return { write: false, result: { action: 'already-recorded', path: file.path } }
      }
    }
  }

  const { targetPath } = followPointerLaw(entry.path, root)
  const target = readEstateFile(targetPath)
  const currentRaw = target?.raw ?? ''
  return {
    write: true,
    result: { action: 'recorded', path: targetPath, created: false },
    path: targetPath,
    before: currentRaw,
    after: appendRuleToContent(currentRaw, rule),
  }
}

export function captureProjectInstruction(options: {
  cwd: string
  rule: string
  replaces?: string
}): CaptureResult {
  const plan = planProjectInstruction(options)
  if (!plan.write) return plan.result
  mkdirSync(dirname(plan.path), { recursive: true })
  writeFileSync(plan.path, plan.after, 'utf8')
  clearInstructionFileCaches()
  return plan.result
}

export function describeCaptureResult(result: CaptureResult): string {
  switch (result.action) {
    case 'recorded':
      return result.created
        ? `Recorded in ${basename(result.path)} (born now) — ${result.path} · the user finds it in /memory by its words`
        : `Recorded in ${basename(result.path)} — ${result.path} · the user finds it in /memory by its words`
    case 'updated':
      return `Updated the existing rule in ${basename(result.path)} — ${result.path} · the user finds it in /memory by its words`
    case 'already-recorded':
      return `Already recorded in ${basename(result.path)} — nothing written`
    case 'replace-miss':
      return `No line matching \`replaces\` found${result.searched.length > 0 ? ` in ${result.searched.map(p => basename(p)).join(', ')}` : ''} — nothing written; re-read the estate and retry`
    case 'invalid':
      return `Nothing recorded: ${result.reason}`
  }
}
