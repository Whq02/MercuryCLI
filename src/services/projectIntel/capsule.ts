
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { getProjectSnapshot } from './snapshot.js'
import { projectIntelEnabled, type SnapshotGeneration, type SnapshotRead } from './contracts.js'
import { collectMemoryRefs } from '../../memdir/memoryRefs.js'
import { isAutoMemoryEnabled } from '../../memdir/paths.js'

export type CapsuleRole =
  | 'primary edit'
  | 'test'
  | 'import neighbour'
  | 'active work'
  | 'recent change'
  | 'instruction'
  | 'knowledge'

export interface CapsuleItem {
  ref: string
  path: string
  role: CapsuleRole
  reason: string
  tier: 1 | 2 | 3 | 4 | 5 | 6
  freshness: string
  bodyPresent: false
}

export interface CapsuleMemoryRef {
  refId: string
  status: 'current' | 'candidate' | 'unconsolidated' | 'needs-review'
  summary: string
  why: string
}

export interface ContextCapsule {
  schema: 1
  workspace: string
  generation: SnapshotGeneration
  task: string
  goal: string | null
  items: CapsuleItem[]
  memoryRefs?: CapsuleMemoryRef[]
  caps: {
    maxItems: number
    maxBytes: number
    omitted: { count: number; reasons: string[] }
  }
  digest: string
  assembleMs: number
}

export interface CapsuleInput {
  workspace: string
  task: string
  goal?: string | null
  activeTaskSubjects?: string[]
  zonePaths?: string[]
  recentFiles?: string[]
  pins?: string[]
  drops?: string[]
  budget?: { maxItems?: number; maxBytes?: number }
  snapshotMaxStaleMs?: number
  snapshotRead?: SnapshotRead | null
}

const DEFAULT_MAX_ITEMS = 12
const DEFAULT_MAX_BYTES = 4096
const IMPORT_SCAN_FILES = 8
const IMPORT_SCAN_LINES = 60
const MEMORY_REF_CAP = 4

const TEST_PATH_RE = /(^|\/)((tests?|__tests__|spec)\/|test_[^/]+\.py$)|\.(test|spec)\.[a-z]+$/
const PATHISH_RE = /[A-Za-z0-9_@./-]*[/.][A-Za-z0-9_@./-]+/g

function fileRef(path: string): string {
  return `mercury://file/${path}`
}

function isTestPath(path: string): boolean {
  return TEST_PATH_RE.test(path)
}

function existsFile(workspace: string, rel: string): boolean {
  try {
    return statSync(join(workspace, rel)).isFile()
  } catch {
    return false
  }
}

export function pathTokens(task: string, workspace: string): string[] {
  const seen = new Set<string>()
  for (const raw of task.match(PATHISH_RE) ?? []) {
    let cleaned = normalize(raw.replace(/^["'`(]+|["'`),.:;?!]+$/g, '')).replace(/^\.\//, '')
    if (!cleaned || cleaned.startsWith('..')) continue
    if (cleaned.startsWith('/')) {
      const prefix = workspace.endsWith('/') ? workspace : `${workspace}/`
      if (!cleaned.startsWith(prefix)) continue
      cleaned = cleaned.slice(prefix.length)
      if (!cleaned || cleaned.startsWith('..')) continue
    }
    if (!cleaned.includes('/') && !/\.[a-z]{1,4}$/i.test(cleaned)) continue
    if (seen.has(cleaned)) continue
    if (existsFile(workspace, cleaned)) seen.add(cleaned)
  }
  return [...seen].sort()
}

export function importNeighbours(workspace: string, rel: string): string[] {
  let head = ''
  try {
    head = readFileSync(join(workspace, rel), 'utf8').split('\n').slice(0, IMPORT_SCAN_LINES).join('\n')
  } catch {
    return []
  }
  const out = new Set<string>()
  const dir = dirname(rel)
  const addIfExists = (candidate: string): boolean => {
    if (candidate.startsWith('..')) return false
    if (existsFile(workspace, candidate)) {
      out.add(candidate)
      return true
    }
    return false
  }
  for (const m of head.matchAll(/from\s+['"](\.[^'"]+)['"]|require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    const spec = (m[1] ?? m[2])!
    const base = normalize(join(dir, spec))
    const candidates = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      base.replace(/\.js$/, '.ts'),
      `${base}/index.ts`,
      `${base}/index.tsx`,
      `${base}/index.js`,
    ]
    for (const candidate of candidates) {
      if (addIfExists(candidate)) break
    }
  }
  for (const m of head.matchAll(/^from\s+(\.+)([A-Za-z_][A-Za-z0-9_.]*)?\s+import\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
    const dots = m[1]!.length
    let baseDir = dir
    for (let i = 1; i < dots; i++) baseDir = dirname(baseDir)
    const modulePath = m[2]
    if (modulePath) {
      const parts = modulePath.split('.')
      const target = join(baseDir, ...parts)
      if (!addIfExists(`${target}.py`)) addIfExists(join(target, '__init__.py'))
    } else {
      const imported = m[3]!
      if (!addIfExists(join(baseDir, `${imported}.py`))) {
        addIfExists(join(baseDir, imported, '__init__.py'))
      }
    }
  }
  return [...out].sort()
}

function tokensOf(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? [])]
}

export function assembleContextCapsule(input: CapsuleInput): ContextCapsule | null {
  if (!projectIntelEnabled()) return null
  const t0 = performance.now()
  const read =
    input.snapshotRead !== undefined
      ? input.snapshotRead
      : getProjectSnapshot(
          input.workspace,
          input.snapshotMaxStaleMs !== undefined ? { maxStaleMs: input.snapshotMaxStaleMs } : {},
        )
  if (!read) return null
  const { snapshot } = read
  const genStamp = snapshot.generation.treeDigest?.slice(0, 12) ?? 'live'
  const maxItems = Math.max(1, input.budget?.maxItems ?? DEFAULT_MAX_ITEMS)
  const maxBytes = Math.max(512, input.budget?.maxBytes ?? DEFAULT_MAX_BYTES)

  const dropped = new Set((input.drops ?? []).map(d => d.replace(/^\.\//, '')))
  let droppedHits = 0
  const candidates: CapsuleItem[] = []
  const taken = new Set<string>()
  const add = (path: string, role: CapsuleRole, tier: CapsuleItem['tier'], reason: string): void => {
    if (dropped.has(path)) {
      droppedHits++
      return
    }
    if (taken.has(path)) return
    taken.add(path)
    candidates.push({
      ref: fileRef(path),
      path,
      role,
      reason,
      tier,
      freshness: genStamp,
      bodyPresent: false,
    })
  }

  const exact = pathTokens(input.task, input.workspace)
  for (const p of exact) {
    add(p, isTestPath(p) ? 'test' : 'primary edit', 1, `named exactly in the task`)
  }

  for (const p of [...(input.pins ?? [])].sort()) {
    if (existsFile(input.workspace, p)) add(p, 'active work', 2, `operator-pinned`)
  }
  for (const z of [...(input.zonePaths ?? [])].sort()) {
    if (existsFile(input.workspace, z)) add(z, 'active work', 2, `inside an accepted work zone`)
  }
  const activeTexts = [...(input.activeTaskSubjects ?? []), ...(input.goal ? [input.goal] : [])]
  for (const text of activeTexts) {
    for (const p of pathTokens(text, input.workspace)) {
      add(p, 'active work', 2, `named by the active goal/task`)
    }
  }

  for (const p of exact.slice(0, IMPORT_SCAN_FILES)) {
    for (const n of importNeighbours(input.workspace, p)) {
      add(n, isTestPath(n) ? 'test' : 'import neighbour', 3, `imported by ${p}`)
    }
  }

  if (snapshot.git.state === 'ok' && read.from !== 'cache-ttl') {
    for (const c of [...snapshot.git.changed].sort((a, b) => a.path.localeCompare(b.path))) {
      add(c.path, 'recent change', 4, `currently changed in the working tree`)
    }
  }
  for (const r of input.recentFiles ?? []) {
    if (existsFile(input.workspace, r)) add(r, 'recent change', 4, `recently observed this session`)
  }

  if (snapshot.instructions.claudeMd) add('CLAUDE.md', 'instruction', 5, `repository instructions`)
  if (snapshot.instructions.agentsMd) add('AGENTS.md', 'instruction', 5, `repository agent instructions`)
  if (snapshot.knowledge.wikiIndex)
    add('docs/wiki/INDEX.md', 'instruction', 5, `the repo's architecture router`)
  if (existsFile(input.workspace, 'docs/ARCHITECTURE.md'))
    add('docs/ARCHITECTURE.md', 'instruction', 5, `architecture overview`)

  const taskTokens = tokensOf(input.task)
  if (snapshot.surface) {
    for (const doc of snapshot.surface.docs) {
      const stem = doc.toLowerCase().replace(/\.[a-z]+$/, '')
      if (taskTokens.some(t => stem.includes(t)) && existsFile(input.workspace, doc)) {
        add(doc, 'knowledge', 6, `doc name matches the task`)
      }
    }
  }

  let memoryRefs: CapsuleMemoryRef[] | undefined
  try {
    if (isAutoMemoryEnabled()) {
      const collected = collectMemoryRefs([input.task, input.goal ?? ''].join(' '), {
        maxRefs: MEMORY_REF_CAP,
        projectRoot: input.workspace,
      })
      if (collected.length > 0) {
        memoryRefs = collected.map(r => ({ refId: r.refId, status: r.status, summary: r.summary, why: r.why }))
      }
    }
  } catch {
    memoryRefs = undefined
  }

  candidates.sort((a, b) => a.tier - b.tier || a.path.localeCompare(b.path))

  const omittedReasons: string[] = []
  if (droppedHits > 0) {
    omittedReasons.push(`${droppedHits} candidate(s) operator-dropped (/orient drop)`)
  }
  let items = candidates
  if (items.length > maxItems) {
    omittedReasons.push(`${items.length - maxItems} candidate(s) over the ${maxItems}-item cap`)
    items = items.slice(0, maxItems)
  }
  let serialized = JSON.stringify(items)
  while (Buffer.byteLength(serialized, 'utf8') > maxBytes && items.length > 1) {
    items = items.slice(0, -1)
    serialized = JSON.stringify(items)
  }
  if (items.length < candidates.length && omittedReasons.length === 0) {
    omittedReasons.push(`${candidates.length - items.length} candidate(s) over the ${maxBytes}-byte cap`)
  } else if (Buffer.byteLength(JSON.stringify(candidates.slice(0, maxItems)), 'utf8') > maxBytes) {
    omittedReasons.push(`byte cap ${maxBytes} trimmed further`)
  }
  const omittedCount = candidates.length - items.length + droppedHits

  const digest = createHash('sha1')
    .update(items.map(i => `${i.ref}·${i.role}·${i.tier}`).join('|'))
    .update('||' + (memoryRefs ?? []).map(r => `${r.refId}·${r.status}·${r.summary}`).join('|'))
    .digest('hex')
    .slice(0, 16)

  return {
    schema: 1,
    workspace: input.workspace,
    generation: snapshot.generation,
    task: input.task.slice(0, 400),
    goal: input.goal ?? null,
    items,
    ...(memoryRefs ? { memoryRefs } : {}),
    caps: {
      maxItems,
      maxBytes,
      omitted: { count: omittedCount, reasons: omittedReasons },
    },
    digest,
    assembleMs: Math.round(performance.now() - t0),
  }
}

export function renderCapsule(capsule: ContextCapsule): string {
  const lines: string[] = [
    `# Working set (task-scoped, generation ${capsule.generation.treeDigest?.slice(0, 12) ?? 'no-digest'})`,
  ]
  for (const item of capsule.items) {
    lines.push(`- ${item.path} — ${item.role}; ${item.reason}`)
  }
  if (capsule.caps.omitted.count > 0 || capsule.caps.omitted.reasons.length > 0) {
    lines.push(`(${capsule.caps.omitted.count} omitted: ${capsule.caps.omitted.reasons.join('; ')})`)
  }
  if (capsule.memoryRefs && capsule.memoryRefs.length > 0) {
    lines.push('Memory (task-scoped refs — dereference before relying; bodies stay in their stores):')
    for (const r of capsule.memoryRefs) {
      const status =
        r.status === 'current'
          ? ''
          : r.status === 'candidate'
            ? ' [CANDIDATE — unverified]'
            : r.status === 'unconsolidated'
              ? ' [recent, unconsolidated]'
              : ' [needs review — cited path moved]'
      lines.push(`- ${r.refId}${status} — ${r.summary} (${r.why})`)
    }
  }
  return lines.join('\n')
}
