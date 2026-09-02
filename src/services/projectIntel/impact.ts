
import { readdirSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { git } from '../gitGraph/observe.js'
import { importNeighbours } from './capsule.js'
import { getProjectSnapshot } from './snapshot.js'
import { projectIntelEnabled, type SnapshotGeneration } from './contracts.js'

const SCAN_FILE_CAP = 400
const SCAN_DEPTH = 5
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py)$/
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'vendor', 'venv', '.venv',
  '__pycache__', '.cache', 'coverage', '.claude', '.mercury',
])
const TEST_PATH_RE = /(^|\/)((tests?|__tests__|spec)\/|test_[^/]+\.py$)|\.(test|spec)\.[a-z]+$/

export interface ImpactProjection {
  target: string
  generation: SnapshotGeneration
  established: {
    imports: string[]
    importedBy: string[]
    tests: string[]
    change: { added: number; deleted: number } | null
    diagnostics: { pendingCount: number; note: string }
  }
  inferences: string[]
  caps: { scannedFiles: number; capped: boolean; omissions: string[] }
}

export function collectCodeFiles(workspace: string): { files: string[]; capped: boolean } {
  const files: string[] = []
  let capped = false
  const walk = (rel: string, depth: number): void => {
    if (depth > SCAN_DEPTH || capped) return
    let entries: string[]
    try {
      entries = readdirSync(join(workspace, rel)).sort()
    } catch {
      return
    }
    for (const name of entries) {
      if (capped) return
      if (name.startsWith('.') && name !== '.github') continue
      const childRel = rel ? `${rel}/${name}` : name
      let st
      try {
        st = statSync(join(workspace, childRel))
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue
        walk(childRel, depth + 1)
      } else if (CODE_EXT.test(name)) {
        if (files.length >= SCAN_FILE_CAP) {
          capped = true
          return
        }
        files.push(childRel)
      }
    }
  }
  walk('', 0)
  return { files, capped }
}

function changeStats(workspace: string, target: string): { added: number; deleted: number } | null {
  let added = 0
  let deleted = 0
  let any = false
  for (const args of [
    ['diff', '--numstat', '--', target],
    ['diff', '--cached', '--numstat', '--', target],
  ]) {
    try {
      const out = git(workspace, args).trim()
      if (!out) continue
      const [a, d] = out.split('\t')
      added += Number(a) || 0
      deleted += Number(d) || 0
      any = true
    } catch {
    }
  }
  return any ? { added, deleted } : null
}

function pendingDiagnostics(): { pendingCount: number; note: string } {
  try {
    const { getPendingLSPDiagnosticCount } =
      require('../lsp/LSPDiagnosticRegistry.js') as typeof import('../lsp/LSPDiagnosticRegistry.js')
    return {
      pendingCount: getPendingLSPDiagnosticCount(),
      note: 'live diagnostics are the LSP diagnostics operation — resolve there; this count is the undelivered stream',
    }
  } catch {
    return { pendingCount: 0, note: 'LSP registry unavailable — diagnostics resolve live via the LSP tool when connected' }
  }
}

export function projectImpact(workspace: string, target: string): ImpactProjection | null {
  if (!projectIntelEnabled()) return null
  const read = getProjectSnapshot(workspace)
  if (!read) return null
  const abs = normalize(join(workspace, target))
  const prefix = workspace.endsWith('/') ? workspace : `${workspace}/`
  if (!abs.startsWith(prefix)) return null
  try {
    if (!statSync(abs).isFile()) return null
  } catch {
    return null
  }

  const neighbourMemo = new Map<string, string[]>()
  const neighboursOf = (file: string): string[] => {
    let cached = neighbourMemo.get(file)
    if (!cached) {
      cached = importNeighbours(workspace, file)
      neighbourMemo.set(file, cached)
    }
    return cached
  }

  const imports = neighboursOf(target)
  const scan = collectCodeFiles(workspace)
  const importedBy: string[] = []
  for (const file of scan.files) {
    if (file === target) continue
    if (neighboursOf(file).includes(target)) importedBy.push(file)
  }
  const tests = importedBy.filter(f => TEST_PATH_RE.test(f))

  const omissions: string[] = []
  if (scan.capped) omissions.push(`reverse-import scan capped at ${SCAN_FILE_CAP} files — importer list may be partial`)
  omissions.push('importer scan resolves RELATIVE specifiers only (alias/package imports are not walked)')
  const inferences: string[] = []
  const secondOrder = new Set<string>()
  for (const importer of importedBy.filter(f => !TEST_PATH_RE.test(f)).slice(0, 8)) {
    for (const file of scan.files) {
      if (file === importer || file === target) continue
      if (neighboursOf(file).includes(importer)) secondOrder.add(file)
    }
  }
  if (secondOrder.size > 0) {
    inferences.push(
      `second-order (importers-of-importers, INFERRED reach — not verified callers): ${[...secondOrder].sort().slice(0, 8).join(', ')}${secondOrder.size > 8 ? ` …+${secondOrder.size - 8}` : ''}`,
    )
  }

  return {
    target,
    generation: read.snapshot.generation,
    established: {
      imports,
      importedBy: importedBy.filter(f => !TEST_PATH_RE.test(f)),
      tests,
      change: changeStats(workspace, target),
      diagnostics: pendingDiagnostics(),
    },
    inferences,
    caps: { scannedFiles: scan.files.length, capped: scan.capped, omissions },
  }
}
