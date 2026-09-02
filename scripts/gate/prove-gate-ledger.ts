#!/usr/bin/env bun
// ============================================================================
//  scripts/gate/prove-gate-ledger.ts — the gate ledger's own proofs.
//
//  The ledger is the record that release eligibility, the pre-push guard and
//  verify:fast's anchors all read, so its key has to hold exactly:
//
//   §1 ELIGIBILITY NEUTRALITY — appending a verdict row and committing it does
//      not change codeTree. Without this the record is useless by
//      construction: a verdict for tree T can only be written after T, so a
//      plain tree hash could never match its own verdict.
//   §2 a recorded green verdict makes its own commit verified;
//   §3 a one-line source change invalidates eligibility;
//   §4 a lockfile change invalidates eligibility;
//   §5 a verdict that is not green — including one with a missing or
//      duplicated shard — can never be recorded;
//   §6 a verdict taken against a dirty tree, or whose content tree is not the
//      commit's own tree, is refused;
//   §7 a hosted query refuses a verdict that ran off the tree's pinned
//      toolchain;
//   §8 a malformed ledger line is an ERROR, never a silent "unverified";
//   §9 the exclusion list is exactly the ledger — one extra entry would be a
//      hole an unverified change could reach a release through.
//
//  Hermetic: every check runs against a scratch git repository under a
//  mkdtemp root, driving the real CLI as a subprocess. This repository's own
//  ledger is never written.
// ============================================================================

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const LEDGER_CLI = join(REPO, 'scripts/gate/ledger.ts')
const BUN = process.execPath
const SCRATCH = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'keel-ledger-')))
// Verdict files live OUTSIDE the scratch repository: writing them inside it
// would let `git add -A` sweep them into the tree, which would change codeTree
// for a reason that has nothing to do with the property under test.
const OUTBOX = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'keel-ledger-out-')))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}

function write(rel: string, body: string): void {
  const full = join(SCRATCH, rel)
  if (!full.startsWith(`${SCRATCH}/`)) throw new Error(`refused write outside scratch: ${full}`)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, body)
}
function sh(cmd: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(cmd, args, { cwd: SCRATCH, encoding: 'utf8' })
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}
function g(...args: string[]): string {
  return execFileSync('git', args, { cwd: SCRATCH, encoding: 'utf8' }).trim()
}
function ledger(...args: string[]): { code: number; out: string } {
  return sh(BUN, ['run', LEDGER_CLI, ...args])
}
function commitAll(message: string): string {
  g('add', '-A')
  g('-c', 'user.email=keel@proof', '-c', 'user.name=keel', 'commit', '-q', '-m', message)
  return g('rev-parse', 'HEAD')
}

// The scratch tree pins the toolchain this process is actually running, so
// the toolchain leg can be exercised positively as well as negatively.
const OBSERVED_NODE = process.version.replace(/^v/, '')
const OBSERVED_BUN = (globalThis as { Bun?: { version?: string } }).Bun?.version ?? '0.0.0'

g('init', '-q', '-b', 'main')
write('.node-version', `${OBSERVED_NODE}\n`)
write('bun.lock', '{"lockfileVersion":1}\n')
write(
  '.github/workflows/gate.yml',
  `name: gate\njobs:\n  x:\n    steps:\n      - run: curl -fsSL https://bun.sh/install | bash -s "bun-v${OBSERVED_BUN}"\n`,
)
write('src/a.ts', 'export const a = 1\n')
write('scripts/gate/gate-ledger.jsonl', '')
const base = commitAll('base')

function verdictFile(commit: string, over: Record<string, unknown> = {}): string {
  const body = {
    ok: true,
    pass: ['alpha', 'beta'],
    fail: [],
    ranAt: '2026-07-27T00:00:00Z',
    headSha: commit,
    dirty: false,
    treeSha: g('rev-parse', `${commit}^{tree}`),
    durations: { alpha: 12, beta: 7 },
    ...over,
  }
  const path = join(OUTBOX, 'verdict.json')
  writeFileSync(path, JSON.stringify(body))
  return path
}

// ── §1 + §2 ────────────────────────────────────────────────────────────────
section('§1–§2 — a recorded verdict verifies its commit, and the row is eligibility-neutral')
const treeBefore = ledger('code-tree').out.trim()
{
  const rec = ledger('record', '--kind', 'hosted', '--run-id', '900001', '--verdict', verdictFile(base))
  check('the green verdict records', rec.code === 0, rec.out.trim())

  const beforeCommit = ledger('check', '--kind', 'hosted')
  check('the tree is verified with the row still uncommitted', beforeCommit.code === 0, beforeCommit.out.trim())

  commitAll('gate: record the hosted verdict')
  const treeAfter = ledger('code-tree').out.trim()
  check(
    'committing the verdict row leaves codeTree unchanged',
    treeAfter === treeBefore && treeBefore.length === 64,
    `${treeBefore.slice(0, 12)} → ${treeAfter.slice(0, 12)}`,
  )

  const afterCommit = ledger('check', '--kind', 'hosted', '--require-toolchain')
  check(
    'the verdict-carrying commit is itself eligible',
    afterCommit.code === 0,
    afterCommit.out.trim(),
  )
}

// ── §3 source change ───────────────────────────────────────────────────────
section('§3 — a one-line source change invalidates eligibility')
{
  write('src/a.ts', 'export const a = 2\n')
  commitAll('src: one line')
  const res = ledger('check', '--kind', 'hosted')
  check('a changed source line is unverified', res.code === 1, res.out.trim())
  write('src/a.ts', 'export const a = 1\n')
  commitAll('src: revert')
  check('reverting restores eligibility', ledger('check', '--kind', 'hosted').code === 0)
}

// ── §4 lockfile ────────────────────────────────────────────────────────────
section('§4 — a lockfile-only change invalidates eligibility')
{
  write('bun.lock', '{"lockfileVersion":1,"packages":{"x":"1.0.0"}}\n')
  commitAll('deps: bump')
  const res = ledger('check', '--kind', 'hosted')
  check('a lockfile-only change is unverified', res.code === 1, res.out.trim())
  write('bun.lock', '{"lockfileVersion":1}\n')
  commitAll('deps: revert')
  check('reverting the lockfile restores eligibility', ledger('check', '--kind', 'hosted').code === 0)
}

// ── §5 non-green verdicts ──────────────────────────────────────────────────
section('§5 — a verdict that is not green can never be recorded')
{
  const head = g('rev-parse', 'HEAD')
  for (const [label, over] of [
    ['a red shard', { ok: false, fail: ['alpha'] }],
    ['a missing shard', { ok: false, missing: ['gamma'] }],
    ['a duplicated shard', { ok: false, duplicated: ['alpha'] }],
  ] as const) {
    const r = ledger('record', '--kind', 'hosted', '--run-id', '900002', '--verdict', verdictFile(head, over))
    check(`${label} is refused`, r.code === 2, r.out.trim().split('\n')[0] ?? '')
  }
}

// ── §6 unbindable verdicts ─────────────────────────────────────────────────
section('§6 — a verdict that cannot be bound to a commit is refused')
{
  const head = g('rev-parse', 'HEAD')
  const dirty = ledger('record', '--kind', 'local', '--verdict', verdictFile(head, { dirty: true }))
  check('a dirty-tree verdict is refused', dirty.code === 2, dirty.out.trim().split('\n')[0] ?? '')

  const wrongTree = ledger(
    'record',
    '--kind',
    'local',
    '--verdict',
    verdictFile(head, { treeSha: '0'.repeat(40) }),
  )
  check(
    'a verdict whose content tree is not the commit tree is refused',
    wrongTree.code === 2,
    wrongTree.out.trim().split('\n')[0] ?? '',
  )

  const noHead = ledger('record', '--kind', 'local', '--verdict', verdictFile(head, { headSha: null }))
  check('a verdict with no resolvable commit is refused', noHead.code === 2)
}

// ── §7 toolchain ───────────────────────────────────────────────────────────
section('§7 — a hosted query refuses a verdict that ran off the pinned toolchain')
{
  const ledgerPath = join(SCRATCH, 'scripts/gate/gate-ledger.jsonl')
  const rows = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean)
  const original = rows[0]!
  const wrong = JSON.parse(original) as Record<string, unknown>
  wrong.toolchain = { node: 'v18.0.0', bun: '0.0.1' }
  wrong.runId = '900003'
  writeFileSync(ledgerPath, `${JSON.stringify(wrong)}\n`)
  commitAll('gate: verdict row from an unpinned toolchain')

  const strict = ledger('check', '--kind', 'hosted', '--require-toolchain')
  check('the off-toolchain verdict is not eligible', strict.code === 1, strict.out.trim())
  const loose = ledger('check', '--kind', 'hosted')
  check('the same row still matches without the toolchain requirement', loose.code === 0)

  writeFileSync(ledgerPath, `${original}\n`)
  commitAll('gate: restore the pinned verdict row')
  check('the pinned row is eligible again', ledger('check', '--kind', 'hosted', '--require-toolchain').code === 0)
}

// ── §8 malformed rows ──────────────────────────────────────────────────────
section('§8 — a malformed ledger row is an error, never a silent "unverified"')
{
  const ledgerPath = join(SCRATCH, 'scripts/gate/gate-ledger.jsonl')
  const good = readFileSync(ledgerPath, 'utf8')
  appendFileSync(ledgerPath, '{ this is not json\n')
  const res = ledger('check', '--kind', 'hosted')
  check(
    'a corrupt row exits with the error code, not the unverified code',
    res.code === 2,
    `exit=${res.code} :: ${res.out.trim().split('\n')[0] ?? ''}`,
  )
  writeFileSync(ledgerPath, good)
}

// ── §9 the exclusion list ──────────────────────────────────────────────────
section('§9 — the codeTree exclusion list is exactly the ledger')
{
  const mod = await import('./ledger.ts')
  check(
    'CODE_TREE_EXCLUDED === [LEDGER_PATH]',
    mod.CODE_TREE_EXCLUDED.length === 1 && mod.CODE_TREE_EXCLUDED[0] === mod.LEDGER_PATH,
    `[${mod.CODE_TREE_EXCLUDED.join(', ')}]`,
  )
  check(
    'the ledger lives at a committed, non-ignored path',
    spawnSync('git', ['check-ignore', '-q', mod.LEDGER_PATH], { cwd: REPO }).status !== 0,
    mod.LEDGER_PATH,
  )
}

console.log(
  `\n${failures === 0 ? '✅' : '❌'} prove-gate-ledger — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`,
)
process.exit(failures === 0 ? 0 : 1)
