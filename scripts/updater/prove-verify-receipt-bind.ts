#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type Row = { commit: string; tree: string | null; kind?: string; ok?: boolean }
type Decision =
  | { ok: true; bound: Row; arm: 'exact' | 'receipt-safe-ancestor' }
  | { ok: false; reason: 'tree-unresolvable' | 'stale-dist' | 'no-covering-row'; detail: string }
type Facts = {
  buildTree: string | null
  workingTree: string | null
  recentCommits: Array<{ commit: string; tree: string }>
  rows: Row[]
  diffPaths: (a: string, b: string) => string[]
}
const bind = (await import('../release/verifyReceiptBind.mjs')) as unknown as {
  RECEIPT_SAFE_PREFIXES: string[]
  isReceiptSafeDiff: (paths: string[]) => boolean
  readLedgerRows: (text: string) => Array<Record<string, unknown>>
  decideVerifyReceiptBind: (facts: Facts) => Decision
  gitTree: (root: string, rev: string) => string | null
  gitRecentCommits: (root: string, n?: number) => Array<{ commit: string; tree: string }>
  gitDiffPaths: (root: string, a: string, b: string) => string[]
  gitWorkingContentTree: (root: string) => string | null
  collectVerifyReceiptFacts: (root: string, buildTree: string, rows: Array<Record<string, unknown>>) => Facts
}

console.log('the verify-receipt bind certifies only the bundle it stages')

section('§1 the pure decision')
{
  const tree = (c: string): string => c.repeat(40)
  const T0 = tree('0')
  const T1 = tree('1')
  const T2 = tree('2')
  const T1d = tree('d')
  const T9 = tree('9')
  const diffs: Record<string, string[]> = {
    [`${T0}..${T1}`]: ['src/utils/auth.ts'],
    [`${T1}..${T2}`]: ['scripts/gate/gate-ledger.jsonl'],
    [`${T0}..${T2}`]: ['src/utils/auth.ts', 'scripts/gate/gate-ledger.jsonl'],
    [`${T1}..${T1d}`]: ['src/services/x.ts'],
    [`${T2}..${T1d}`]: ['src/services/x.ts', 'scripts/gate/gate-ledger.jsonl'],
    [`${T9}..${T1}`]: ['docs/notes.md'],
    [`${T9}..${T2}`]: ['docs/notes.md', 'scripts/gate/gate-ledger.jsonl'],
  }
  const diffPaths = (a: string, b: string): string[] => {
    if (a === b) return []
    const hit = diffs[`${a}..${b}`] ?? diffs[`${b}..${a}`]
    if (hit === undefined) throw new Error(`no fixture diff for ${a.slice(0, 4)}..${b.slice(0, 4)}`)
    return hit
  }
  const recent = [
    { commit: 'c2', tree: T2 },
    { commit: 'c1', tree: T1 },
    { commit: 'c0', tree: T0 },
  ]
  const row = (commit: string, t: string | null, kind = 'local'): Row => ({ commit, tree: t, kind, ok: true })
  const decide = (over: Partial<Facts>): Decision =>
    bind.decideVerifyReceiptBind({ buildTree: T2, workingTree: T2, recentCommits: recent, rows: [], diffPaths, ...over })

  check('the record prefixes are the three the fold-commit pattern touches', bind.RECEIPT_SAFE_PREFIXES.join(',') === 'docs/,scripts/gate/gate-ledger.jsonl,scripts/gate/duration-seed.tsv')
  check('a ledger-only diff is receipt-safe; a src path is not', bind.isReceiptSafeDiff(['scripts/gate/gate-ledger.jsonl', 'docs/a.md']) && !bind.isReceiptSafeDiff(['docs/a.md', 'src/x.ts']))

  const exact = decide({ rows: [row('c2', T2)] })
  check('a row whose tree IS the build tree binds exactly', exact.ok && exact.arm === 'exact' && exact.bound.commit === 'c2', JSON.stringify(exact))

  const fold = decide({ rows: [row('c1', T1)] })
  check('the fold-commit pattern binds as a receipt-safe ancestor', fold.ok && fold.arm === 'receipt-safe-ancestor' && fold.bound.commit === 'c1', JSON.stringify(fold))

  const stale = decide({ buildTree: T0, rows: [row('c2', T2)] })
  check('A STALE DIST IS REFUSED before any row is read (the base certified it)', !stale.ok && stale.reason === 'stale-dist', JSON.stringify(stale))
  check('…and the refusal names the offending path', !stale.ok && /src\/utils\/auth\.ts/.test(stale.detail), !stale.ok ? stale.detail : '')
  const staleExact = decide({ buildTree: T0, rows: [row('c0', T0)] })
  check('…even when an old row matches the stale dist exactly', !staleExact.ok && staleExact.reason === 'stale-dist')

  const dirty = decide({ buildTree: T1d, workingTree: T1d, rows: [row('c1', T1)] })
  check('a row graded on other code never covers the build tree (the diff is judged against the BUILD tree)', !dirty.ok && dirty.reason === 'no-covering-row', JSON.stringify(dirty))

  const foreign = decide({ rows: [row('cx', T9)] })
  check("a graded tree outside HEAD's recent history never binds, however small its diff", !foreign.ok && foreign.reason === 'no-covering-row')

  const skipped = decide({ rows: [row('elsewhere', null), row('c2', T2)] })
  check('a row whose commit is not in this clone is skipped, not fatal', skipped.ok && skipped.bound.commit === 'c2')

  const newest = decide({ rows: [row('c2', T2, 'hosted'), row('c1', T1, 'local')] })
  check('the newest covering row wins', newest.ok && newest.bound.kind === 'hosted')

  const noBuild = decide({ buildTree: null })
  const noWorking = decide({ workingTree: null, rows: [row('c2', T2)] })
  check('no buildTree ⇒ tree-unresolvable', !noBuild.ok && noBuild.reason === 'tree-unresolvable')
  check("an unresolvable checkout tree ⇒ tree-unresolvable (never a bind on HEAD's word)", !noWorking.ok && noWorking.reason === 'tree-unresolvable')

  const rows = bind.readLedgerRows(
    ['{"ok":true,"commit":"a"}', 'not json', '{"ok":false,"commit":"b"}', '{"ok":true}', '{"ok":true,"commit":"c","kind":"hosted"}'].join('\n'),
  )
  check('readLedgerRows keeps green rows with a commit, newest first', rows.length === 2 && rows[0]?.commit === 'c' && rows[1]?.commit === 'a', JSON.stringify(rows))
}

section('§2 the git facts against a scratch repository')
{
  const repo = mkdtempSync(join(tmpdir(), 'verify-receipt-repo-'))
  const g = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@example.invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@example.invalid' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  try {
    g('init', '-q')
    mkdirSync(join(repo, 'src'), { recursive: true })
    mkdirSync(join(repo, 'docs'), { recursive: true })
    writeFileSync(join(repo, 'src', 'a.txt'), 'one\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'A: the code')
    const A = g('rev-parse', 'HEAD')
    const treeA = g('rev-parse', 'HEAD^{tree}')
    writeFileSync(join(repo, 'docs', 'b.md'), 'record\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'B: a record path')
    const B = g('rev-parse', 'HEAD')
    const treeB = g('rev-parse', 'HEAD^{tree}')

    check('gitTree resolves a commit to its tree', bind.gitTree(repo, A) === treeA && bind.gitTree(repo, 'HEAD') === treeB)
    check('gitTree answers null for a commit not in the clone', bind.gitTree(repo, 'f'.repeat(40)) === null)
    const recent = bind.gitRecentCommits(repo)
    check('gitRecentCommits walks HEAD newest first with trees', recent.length === 2 && recent[0]?.commit === B && recent[0]?.tree === treeB && recent[1]?.tree === treeA, JSON.stringify(recent))
    check('gitDiffPaths diffs two TREES (not commits)', bind.gitDiffPaths(repo, treeA, treeB).join(',') === 'docs/b.md')
    check('a clean checkout: the working-content tree IS HEAD\'s tree', bind.gitWorkingContentTree(repo) === treeB)

    writeFileSync(join(repo, 'src', 'c.txt'), 'uncommitted\n')
    const dirtyTree = bind.gitWorkingContentTree(repo)
    check('a dirty checkout: the working-content tree differs from HEAD\'s', typeof dirtyTree === 'string' && dirtyTree !== treeB)
    check('…and the diff names the uncommitted path', dirtyTree !== null && bind.gitDiffPaths(repo, treeB, dirtyTree).join(',') === 'src/c.txt')

    const staleFacts = bind.collectVerifyReceiptFacts(repo, treeA, [{ ok: true, commit: A, kind: 'local' }])
    const stale = bind.decideVerifyReceiptBind(staleFacts)
    check('collectVerifyReceiptFacts resolves the row\'s tree', staleFacts.rows[0]?.tree === treeA)
    check('a dist built before this checkout\'s content is refused as stale (real git)', !stale.ok && stale.reason === 'stale-dist', JSON.stringify(stale))

    unlinkSync(join(repo, 'src', 'c.txt'))
    const fold = bind.decideVerifyReceiptBind(bind.collectVerifyReceiptFacts(repo, treeB, [{ ok: true, commit: A, kind: 'local' }]))
    check('the fold-commit pattern binds on real git', fold.ok && fold.arm === 'receipt-safe-ancestor' && fold.bound.commit === A, JSON.stringify(fold))
    const exact = bind.decideVerifyReceiptBind(bind.collectVerifyReceiptFacts(repo, treeB, [{ ok: true, commit: B, kind: 'hosted' }]))
    check('an exact row binds on real git', exact.ok && exact.arm === 'exact')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

section('§3 the packager consumes the one decision')
{
  const packager = readFileSync(join(ROOT, 'scripts/release/package.mjs'), 'utf8')
  check('package.mjs imports the bind module', /from '\.\/verifyReceiptBind\.mjs'/.test(packager))
  check('the facts are collected against the staged manifest\'s buildTree', /collectVerifyReceiptFacts\(ROOT, manifest\.buildTree, rows\)/.test(packager))
  check('the decision is the module\'s', /decideVerifyReceiptBind\(/.test(packager))
  check('the HEAD-diffing ancestor walk is gone', !/gradedTreeIsReceiptSafeAncestor/.test(packager) && !/'diff', '--name-only', c, 'HEAD'/.test(packager))
  check('a stale dist fails with no escape', /reason === 'stale-dist'/.test(packager) && /is STALE/.test(packager) && /no escape covers/.test(packager))
  check('the missing-row escape stays the loud dev door', /--allow-stale-verify-receipts/.test(packager))
  let nodeOk = true
  try {
    execFileSync('node', ['--check', join(ROOT, 'scripts/release/verifyReceiptBind.mjs')], { stdio: 'pipe' })
    execFileSync('node', ['--check', join(ROOT, 'scripts/release/package.mjs')], { stdio: 'pipe' })
  } catch {
    nodeOk = false
  }
  check('the module and the packager pass node --check', nodeOk)
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-verify-receipt-bind${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
