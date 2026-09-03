/* scripts/release/verifyReceiptBind.mjs — the packager's verify-receipt bind:
 * which green gate-ledger row covers the STAGED bundle? Pure decision +
 * the git fact collectors, so the rule is pinnable without a dist.
 *
 * The staged dist is the thing being shipped, so every arm is judged
 * against manifest.buildTree — never against HEAD in its place. The old
 * receipt-safe-ancestor arm walked HEAD's recent commits for the row's
 * tree and diffed THAT COMMIT AGAINST HEAD, never consulting the build tree
 * at all: a green row for HEAD's ancestor certified whatever bytes sat in
 * dist/, a bundle built before the fixes the row graded included
 * (FN-019's dropped candidate — a real pipeline defect that no documented
 * road reached, closed here as the defect it is). Two rules:
 *
 *   1. STALENESS FIRST. The staged bundle must be this checkout's content
 *      (the working-content tree build.ts stamps: HEAD + the working
 *      changes), or differ from it only by record paths — the fold-commit
 *      pattern: pool on the candidate tree, then commit the ledger row. A
 *      dist built from other content is refused before any row is read;
 *      no escape covers it, only a rebuild.
 *   2. A ROW BINDS TO THE BUILD TREE. Exactly, when the row's commit tree
 *      IS the build tree; or as a receipt-safe ancestor, when the graded
 *      tree is in HEAD's recent history and differs from the BUILD tree
 *      only by record paths (the ancestor walk applies to the graded
 *      commit against the build tree — it never substitutes for it).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The record paths a graded tree may differ from the build tree by. */
export const RECEIPT_SAFE_PREFIXES = ['docs/', 'scripts/gate/gate-ledger.jsonl', 'scripts/gate/duration-seed.tsv']

export const isReceiptSafePath = (p) => RECEIPT_SAFE_PREFIXES.some((pre) => p.startsWith(pre))
export const isReceiptSafeDiff = (paths) => paths.every(isReceiptSafePath)

const short = (tree) => String(tree).slice(0, 12) + '…'

/** Kinds that report and never verify (scripts/gate/ledger.ts ADVISORY_KINDS): a drives verdict binds nothing. */
export const ADVISORY_KINDS = ['hosted-drives']

/** The ledger's green, verifying rows, newest first (the file appends). */
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

/**
 * The pure decision.
 *
 * facts:
 *   buildTree      — manifest.buildTree, the staged bundle's content tree
 *   workingTree    — this checkout's content tree (null: unresolvable)
 *   recentCommits  — [{ commit, tree }] over HEAD's recent history
 *   rows           — green ledger rows, newest first, each with `tree`
 *                    (the commit's tree; null when not in this clone)
 *   diffPaths(a,b) — the paths differing between two tree-ish objects
 *
 * returns { ok: true, bound, arm: 'exact' | 'receipt-safe-ancestor' }
 *      or { ok: false, reason: 'tree-unresolvable' | 'stale-dist' | 'no-covering-row', detail }
 */
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

// ── the git fact collectors (typed argv: revisions ride as ONE argv element
// each — never through a shell string) ────────────────────────────────────

const git = (root, args, env) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...(env ? { env } : {}) }).trim()

/** A revision's tree, or null when it is not in this clone. */
export function gitTree(root, rev) {
  try {
    return git(root, ['rev-parse', `${rev}^{tree}`])
  } catch {
    return null
  }
}

/** HEAD's recent history with each commit's tree (newest first). */
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

/** The paths differing between two tree-ish objects. */
export function gitDiffPaths(root, a, b) {
  return git(root, ['diff', '--name-only', a, b]).split('\n').filter(Boolean)
}

/** This checkout's CONTENT tree — the same idiom build.ts stamps and
 *  dist-cache-check.sh reads: a temp index seeded from HEAD, `git add -A`,
 *  `git write-tree`. Equals HEAD's tree on a clean checkout; null when it
 *  cannot be resolved. */
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

/** Every fact the decision needs, collected from one checkout. */
export function collectVerifyReceiptFacts(root, buildTree, ledgerRows) {
  return {
    buildTree,
    workingTree: gitWorkingContentTree(root),
    recentCommits: gitRecentCommits(root),
    rows: ledgerRows.map((row) => ({ ...row, tree: gitTree(root, row.commit) })),
    diffPaths: (a, b) => gitDiffPaths(root, a, b),
  }
}
