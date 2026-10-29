
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, normalize, relative, resolve } from 'node:path'
import { safeParseJSONC } from '../../utils/json.js'
import { loadTs, resolveStructureTypescript } from '../structure/tsFacility.js'
import { getProjectSnapshot } from './snapshot.js'
import { projectIntelEnabled, type SnapshotGeneration, type SnapshotRead } from './contracts.js'
import { lookupTokens } from '../../mneme/mnemeLookup.js'

type CapsuleRole =
  | 'primary edit'
  | 'test'
  | 'import neighbour'
  | 'active work'
  | 'recent change'
  | 'instruction'
  | 'knowledge'

interface CapsuleItem {
  ref: string
  path: string
  role: CapsuleRole
  reason: string
  tier: 1 | 2 | 3 | 4 | 5 | 6
  freshness: string
  bodyPresent: false
}

interface ContextCapsule {
  schema: 1
  workspace: string
  generation: SnapshotGeneration
  task: string
  goal: string | null
  items: CapsuleItem[]
  caps: {
    maxItems: number
    maxBytes: number
    omitted: { count: number; reasons: string[] }
  }
  digest: string
  assembleMs: number
}

interface CapsuleInput {
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
export const RECENTLY_OBSERVED_REASON = 'recently observed this session'

const TEST_PATH_RE = /(^|\/)((tests?|__tests__|spec)\/|test_[^/]+\.py$)|\.(test|spec)\.[a-z]+$/
const PATHISH_RE = /[A-Za-z0-9_@./-]+/g

function fileRef(path: string): string {
  return `mercury://file/${path}`
}

function isTestPath(path: string): boolean {
  return TEST_PATH_RE.test(path)
}

function existsFile(workspace: string, rel: string): boolean {
  try {
    const root = realpathSync(workspace)
    const target = realpathSync(resolve(workspace, rel))
    return target.startsWith(root + '/') && statSync(target).isFile()
  } catch {
    return false
  }
}

export const SCAN_FILE_CAP = 400

export function collectCodeFiles(workspace: string): { files: string[]; capped: boolean } {
  const files: string[] = []
  let capped = false
  const skipped = new Set(['node_modules', 'dist', 'build', 'out', 'vendor', 'venv', '__pycache__', 'coverage'])
  const walk = (rel: string, depth: number): void => {
    if (depth > 5 || capped) return
    let entries
    try { entries = readdirSync(join(workspace, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) } catch { return }
    for (const entry of entries) {
      if (capped) return
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory() && !skipped.has(entry.name)) walk(child, depth + 1)
      else if (entry.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs|py)$/.test(entry.name)) {
        if (files.length >= SCAN_FILE_CAP) { capped = true; return }
        files.push(child)
      }
    }
  }
  walk('', 0)
  return { files, capped }
}

function resolveSpecifier(workspace: string, spec: string, from = ''): string | undefined {
  const bases = spec.startsWith('.') ? [join(dirname(from), spec)] : from && !spec.startsWith('/') ? [] : [spec]
  if (!spec.startsWith('.') && !spec.startsWith('/')) {
    let directory = dirname(resolve(workspace, from || 'index.ts'))
    for (let depth = 0; depth <= 5 && (directory === resolve(workspace) || directory.startsWith(resolve(workspace) + '/')); depth++, directory = dirname(directory)) {
      const file = join(directory, 'tsconfig.json')
      try {
        if (statSync(file).size > 65536) break
        const config = safeParseJSONC(readFileSync(file, 'utf8')) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, unknown> } } | null
        const options = config?.compilerOptions
        const base = resolve(directory, typeof options?.baseUrl === 'string' ? options.baseUrl : '.')
        const entries = Object.entries(options?.paths ?? {}).sort(([a], [b]) => b.replace('*', '').length - a.replace('*', '').length)
        for (const [pattern, targets] of entries) {
          const star = pattern.indexOf('*')
          const matches = star < 0 ? spec === pattern : spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1))
          if (!matches || !Array.isArray(targets)) continue
          const captured = star < 0 ? '' : spec.slice(star, spec.length - (pattern.length - star - 1))
          bases.unshift(...targets.filter((target): target is string => typeof target === 'string').map(target => relative(workspace, resolve(base, target.replace('*', captured)))))
          break
        }
        if (options?.baseUrl) bases.push(relative(workspace, resolve(base, spec)))
        break
      } catch {}
    }
  }
  for (const base of bases) {
    const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, base.replace(/\.js$/, '.ts'), `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`]
    for (const candidate of candidates) if (existsFile(workspace, candidate)) return relative(workspace, resolve(workspace, candidate))
  }
  return undefined
}

export function pathTokens(task: string, workspace: string): string[] {
  const seen = new Set<string>()
  const basenames = new Set<string>()
  for (const [raw] of task.matchAll(PATHISH_RE)) {
    const separator = raw.search(/[/.]/)
    if (separator < 0 || separator === raw.length - 1) continue
    let end = raw.length
    while (end > 0 && raw[end - 1] === '.') end--
    let cleaned = normalize(raw.slice(0, end)).replace(/^\.\//, '')
    if (!cleaned || cleaned.startsWith('..')) continue
    if (cleaned.startsWith('/')) {
      const prefix = workspace.endsWith('/') ? workspace : `${workspace}/`
      if (!cleaned.startsWith(prefix)) continue
      cleaned = cleaned.slice(prefix.length)
      if (!cleaned || cleaned.startsWith('..')) continue
    }
    if (!cleaned.includes('/') && !/\.[a-z]{1,4}$/i.test(cleaned)) continue
    if (seen.has(cleaned)) continue
    const resolved = resolveSpecifier(workspace, cleaned)
    if (resolved) seen.add(resolved)
    else if (!cleaned.includes('/')) basenames.add(cleaned)
  }
  const symbols = new Set([...task.matchAll(PATHISH_RE)].map(match => match[0]).filter(word => /^[A-Za-z_][A-Za-z0-9_]*$/.test(word)))
  if (basenames.size || symbols.size) {
    const scan = collectCodeFiles(workspace)
    for (const name of basenames) {
      const matches = scan.files.filter(file => basename(file) === name)
      if (!scan.capped && matches.length === 1) seen.add(matches[0]!)
    }
    const compiler = symbols.size && !scan.capped ? resolveStructureTypescript(workspace) : null
    if (compiler !== null && compiler.state === 'ok') {
      const ts = loadTs(compiler.modulePath)
      const definitions = new Map<string, string[]>()
      for (const file of scan.files) {
        if (!/\.[cm]?[jt]sx?$/.test(file)) continue
        try {
          const text = readFileSync(join(workspace, file), 'utf8').split('\n').slice(0, IMPORT_SCAN_LINES).join('\n')
          const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false)
          for (const statement of source.statements) {
            const declarations = ts.isVariableStatement(statement) ? statement.declarationList.declarations : [statement]
            for (const node of declarations) {
              const name = (node as import('typescript').NamedDeclaration).name
              if (name && ts.isIdentifier(name) && symbols.has(name.text)) definitions.set(name.text, [...(definitions.get(name.text) ?? []), file])
            }
          }
        } catch {}
      }
      for (const matches of definitions.values()) if (!scan.capped && matches.length === 1) seen.add(matches[0]!)
    }
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
  for (const m of head.matchAll(/from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const resolved = resolveSpecifier(workspace, (m[1] ?? m[2])!, rel)
    if (resolved) out.add(resolved)
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
    if (existsFile(input.workspace, r)) add(r, 'recent change', 4, RECENTLY_OBSERVED_REASON)
  }

  if (snapshot.instructions.mercuryMd) add('MERCURY.md', 'instruction', 5, `repository instructions`)
  if (snapshot.instructions.agentsMd) add('AGENTS.md', 'instruction', 5, `repository agent instructions`)
  if (snapshot.knowledge.wikiIndex)
    add('docs/wiki/INDEX.md', 'instruction', 5, `the repo's architecture router`)
  if (existsFile(input.workspace, 'docs/ARCHITECTURE.md'))
    add('docs/ARCHITECTURE.md', 'instruction', 5, `architecture overview`)

  const taskTokens = lookupTokens(input.task)
  if (snapshot.surface) {
    for (const doc of snapshot.surface.docs) {
      const nameWords = doc.slice(doc.lastIndexOf('/') + 1).toLowerCase().replace(/\.[a-z]+$/, '').split(/[^a-z0-9]+/)
      if (taskTokens.some(t => nameWords.includes(t)) && existsFile(input.workspace, doc)) {
        add(doc, 'knowledge', 6, `doc name matches the task`)
      }
    }
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
    .digest('hex')
    .slice(0, 16)

  return {
    schema: 1,
    workspace: input.workspace,
    generation: snapshot.generation,
    task: input.task.slice(0, 400),
    goal: input.goal ?? null,
    items,
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
  return lines.join('\n')
}
