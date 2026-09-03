import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const RECEIPT_SAFE_PREFIXES = ['docs/', 'scripts/gate/gate-ledger.jsonl', 'scripts/gate/duration-seed.tsv']

export const isReceiptSafePath = (p) => RECEIPT_SAFE_PREFIXES.some((pre) => p.startsWith(pre))
export const isReceiptSafeDiff = (paths) => paths.every(isReceiptSafePath)

const short = (tree) => String(tree).slice(0, 12) + '…'

export const ADVISORY_KINDS = ['hosted-drives']

export function readLedgerRows(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter((r) => r && r.ok === true && typeof r.commit === 'string' && !ADVISORY_KINDS.includes(r.kind))
    .reverse()
}

export function decideVerifyReceiptBind(facts) {
  const { buildTree, workingTree, recentCommits, rows, diffPaths } = facts
  if (typeof buildTree !== 'string' || buildTree.length !== 40) {
    return { ok: false, reason: 'tree-unresolvable', detail: 'the staged manifest carries no buildTree (a pre-stamp build) — rebuild' }
  }
  if (typeof workingTree !== 'string' || workingTree.length !== 40) {
    return { ok: false, reason: 'tree-unresolvable', detail: "this checkout's content tree could not be resolved (no git, or an unborn HEAD)" }
  }
  if (workingTree !== buildTree) {
    const touched = diffPaths(workingTree, buildTree)
    const offending = touched.filter((p) => !isReceiptSafePath(p))
    if (offending.length > 0) {
      return {
        ok: false,
        reason: 'stale-dist',
        detail: `the staged bundle was built from ${short(buildTree)}, not this checkout's content ${short(workingTree)} — ${offending.length} non-record path(s) differ (${offending.slice(0, 3).join(', ')})`,
      }
    }
  }
  const recentTrees = new Set(recentCommits.map((c) => c.tree))
  for (const row of rows) {
    if (typeof row.tree !== 'string') continue
    if (row.tree === buildTree) return { ok: true, bound: row, arm: 'exact' }
    if (!recentTrees.has(row.tree)) continue
    if (isReceiptSafeDiff(diffPaths(row.tree, buildTree))) return { ok: true, bound: row, arm: 'receipt-safe-ancestor' }
  }
  return { ok: false, reason: 'no-covering-row', detail: `no green gate-ledger verdict covers the staged tree ${short(buildTree)}` }
}


const git = (root, args, env) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...(env ? { env } : {}) }).trim()

export function gitTree(root, rev) {
  try {
    return git(root, ['rev-parse', `${rev}^{tree}`])
  } catch {
    return null
  }
}

export function gitRecentCommits(root, n = 50) {
  try {
    return git(root, ['rev-list', '-n', String(n), 'HEAD'])
      .split('\n')
      .filter(Boolean)
      .map((commit) => ({ commit, tree: gitTree(root, commit) }))
      .filter((c) => c.tree !== null)
  } catch {
    return []
  }
}

export function gitDiffPaths(root, a, b) {
  return git(root, ['diff', '--name-only', a, b]).split('\n').filter(Boolean)
}

export function gitWorkingContentTree(root) {
  let idxDir = null
  try {
    idxDir = mkdtempSync(join(tmpdir(), 'verify-receipt-tree-'))
    const env = { ...process.env, GIT_INDEX_FILE: join(idxDir, 'index') }
    git(root, ['read-tree', 'HEAD'], env)
    git(root, ['add', '-A'], env)
    const tree = git(root, ['write-tree'], env)
    return tree.length === 40 ? tree : null
  } catch {
    return null
  } finally {
    if (idxDir !== null) rmSync(idxDir, { recursive: true, force: true })
  }
}

export function collectVerifyReceiptFacts(root, buildTree, ledgerRows) {
  return {
    buildTree,
    workingTree: gitWorkingContentTree(root),
    recentCommits: gitRecentCommits(root),
    rows: ledgerRows.map((row) => ({ ...row, tree: gitTree(root, row.commit) })),
    diffPaths: (a, b) => gitDiffPaths(root, a, b),
  }
}
