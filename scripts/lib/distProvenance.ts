import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit, type GitResult } from './git.ts'

type DistProvenance =
  | { kind: 'own'; tree: string; committed: boolean }
  | { kind: 'absent' }
  | { kind: 'no-manifest' }
  | { kind: 'no-build-tree' }
  | { kind: 'no-git'; detail: string }
  | { kind: 'other-tree'; buildTree: string; contentTree: string; committed: boolean }

const TREE = /^[0-9a-f]{40}$/
const GIT_TIMEOUT_MS = 120_000

function gitMiss(r: Exclude<GitResult, { state: 'ok' }>): string {
  if (r.state === 'nonzero') return `git exited ${r.code}: ${r.stderr.slice(0, 160)}`
  if (r.state === 'unavailable') return `git unavailable: ${r.detail}`
  if (r.state === 'timeout') return 'git timed out'
  return `git output malformed: ${r.detail}`
}

function contentTree(root: string): GitResult {
  const indexDir = mkdtempSync(join(tmpdir(), 'dist-provenance-'))
  const env = { ...process.env, GIT_INDEX_FILE: join(indexDir, 'index') }
  try {
    const read = runGit(['read-tree', 'HEAD'], { cwd: root, env, timeoutMs: GIT_TIMEOUT_MS })
    if (read.state !== 'ok') return read
    const add = runGit(['add', '-A'], { cwd: root, env, timeoutMs: GIT_TIMEOUT_MS })
    if (add.state !== 'ok') return add
    return runGit(['write-tree'], { cwd: root, env, timeoutMs: GIT_TIMEOUT_MS })
  } finally {
    rmSync(indexDir, { recursive: true, force: true })
  }
}

export function distProvenance(root: string): DistProvenance {
  if (!existsSync(join(root, 'dist', 'mercury.mjs'))) return { kind: 'absent' }
  const manifestPath = join(root, 'dist', 'manifest.json')
  if (!existsSync(manifestPath)) return { kind: 'no-manifest' }
  let buildTree: unknown
  try {
    buildTree = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { buildTree?: unknown }).buildTree
  } catch {
    return { kind: 'no-manifest' }
  }
  if (typeof buildTree !== 'string' || !TREE.test(buildTree)) return { kind: 'no-build-tree' }
  const head = runGit(['rev-parse', 'HEAD^{tree}'], { cwd: root, timeoutMs: GIT_TIMEOUT_MS })
  if (head.state !== 'ok') return { kind: 'no-git', detail: gitMiss(head) }
  const content = contentTree(root)
  if (content.state !== 'ok') return { kind: 'no-git', detail: gitMiss(content) }
  const tree = content.stdout.trim()
  const committed = tree === head.stdout.trim()
  if (tree === buildTree) return { kind: 'own', tree, committed }
  return { kind: 'other-tree', buildTree, contentTree: tree, committed }
}

export function distProvenanceLine(p: DistProvenance): string {
  switch (p.kind) {
    case 'own':
      return `dist/mercury.mjs is this checkout's build (tree ${p.tree.slice(0, 12)}, ${p.committed ? 'the committed tree' : 'uncommitted content'}) — dist pins strict`
    case 'absent':
      return '[SKIP] dist/mercury.mjs not built — dist pins skipped (pool Phase 0 rebuilds it)'
    case 'no-manifest':
      return "[SKIP] dist/manifest.json missing or unreadable — the build's tree is unknown; dist pins skipped (rebuild for the strict leg)"
    case 'no-build-tree':
      return '[SKIP] dist/manifest.json carries no buildTree — a build outside git; dist pins skipped (rebuild inside the checkout for the strict leg)'
    case 'no-git':
      return `[SKIP] the checkout's tree could not be read (${p.detail}); dist pins skipped`
    case 'other-tree':
      return `[SKIP] dist/mercury.mjs was built from another tree (dist ${p.buildTree.slice(0, 12)} · checkout ${p.contentTree.slice(0, 12)}${p.committed ? '' : ', uncommitted changes'}) — stale build; dist pins skipped (rebuild or run in the pool for the strict leg)`
  }
}

const NOT_A_BUILD_INPUT = /^(docs\/|design-system\/|scripts\/(?!vendor\/)|field\/|\.claude\/|\.mercury\/|\.github\/|[^/]+\.md$|(?:.+\/)?\.gitignore$)/

export function distBuildInputs(root: string): { stale: boolean; line: string } {
  const p = distProvenance(root)
  switch (p.kind) {
    case 'own':
      return { stale: false, line: `dist/mercury.mjs is this checkout's build (tree ${p.tree.slice(0, 12)}, ${p.committed ? 'the committed tree' : 'uncommitted content'})` }
    case 'absent':
      return { stale: false, line: 'dist/mercury.mjs is not built — a writer that drives the bundle says so itself' }
    case 'no-manifest':
      return { stale: false, line: "dist/manifest.json is missing or unreadable — the bundle's tree is unknown and cannot be compared with the checkout" }
    case 'no-build-tree':
      return { stale: false, line: 'dist/manifest.json carries no buildTree (a build outside git) — the bundle cannot be compared with the checkout' }
    case 'no-git':
      return { stale: false, line: `the checkout's tree could not be read (${p.detail}) — the bundle cannot be compared with it` }
    case 'other-tree': {
      const trees = `dist ${p.buildTree.slice(0, 12)} · checkout ${p.contentTree.slice(0, 12)}${p.committed ? '' : ', uncommitted changes'}`
      const diff = runGit(['diff-tree', '-r', '--name-only', p.buildTree, p.contentTree], { cwd: root, timeoutMs: GIT_TIMEOUT_MS })
      if (diff.state !== 'ok') return { stale: true, line: `dist/mercury.mjs was built from a tree this repository cannot compare with the checkout (${trees}; ${gitMiss(diff)})` }
      const changed = diff.stdout.split('\n').filter(Boolean)
      const inputs = changed.filter(path => !NOT_A_BUILD_INPUT.test(path))
      if (inputs.length === 0) return { stale: false, line: `dist/mercury.mjs was built from another tree (${trees}); the ${changed.length} changed path${changed.length === 1 ? ' is' : 's are'} none of the build's inputs (docs, proofs, stored frames, root notes, ignore rules)` }
      return { stale: true, line: `dist/mercury.mjs was built from another tree (${trees}); ${inputs.length} build input${inputs.length === 1 ? '' : 's'} changed since: ${inputs.slice(0, 5).join(', ')}${inputs.length > 5 ? ', …' : ''}` }
    }
  }
}
