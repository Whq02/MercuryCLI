#!/usr/bin/env bun
// ============================================================================
//  scripts/workflows/bench-replay.ts — the replay benchmarks' SHARED HARNESS:
//  corpus load + digest, the outside judge, per-task clone isolation at the
//  pinned corpus commit, the scrubbed child env, and credential seeding /
//  scrubbing for scratch config dirs. bench-workflow-routing.ts is the live
//  consumer (twelve exports); no run-all.sh ever references this file — a
//  real benchmark run spawns API-BILLED agents and is operator-invoked only.
//
//  The routed-vs-solo seat benchmark that once ran from this file (its arms,
//  its dispatch writer, its settle watcher and its roster seed) retired with
//  the router party's seat estate: its arms imported modules that left the
// tree, so the body could no longer run — the tree trimmed the
//  file to the harness.
//
//  ISOLATION MODEL (cloneAtSha):
//   Per task × arm: a fresh LOCAL CLONE of this repo with BOTH the working
//   tree and refs/remotes/origin/main pinned to the corpus commit — agent
//   lane worktrees (createAgentWorktree) resolve the clone as their canonical
//   root AND base on origin/main, so lanes nest inside the clone at the pinned
//   base (a git WORKTREE would leak lanes into this repo's canonical root at
//   whatever origin/main happens to be — the cross-daemon contamination
//   class). node_modules is clonefile-copied (APFS CoW) so successChecks that
//   run suites/typecheck work. Each task also gets a scratch MERCURY_CONFIG_DIR
//   (teams/inboxes, daemon dir, control socket, cron table all derive from it
//   — nothing touches the operator's home). Child env is SCRUBBED
//   (benchChildEnv): every session HERMES_*/TF_* override is dropped so
//   children run shipped defaults plus exactly the vars the caller sets.
//
//  JUDGE (judgeChecks): the corpus doctrine — successChecks judge from
//  OUTSIDE the agent (a shell command that must exit 0, or a file grep), so
//  a run's own envelope never grades itself.
// ============================================================================
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

export type SuccessCheck =
  | { kind: 'cmd'; cmd: string }
  | { kind: 'grep'; file: string; pattern: string; flags?: string }
export type CorpusTask = {
  id: string
  title: string
  prompt: string
  baseRef: string
  timeboxMs: number
  successChecks: SuccessCheck[]
  tags: string[]
}
/** Both arms get the same containment contract: calibration #2's solo agent
 *  did the task CORRECTLY — in the ORIGIN checkout (the clone's git remote
 *  points at the operator's repo), leaving its own workspace pristine and
 *  contaminating the operator's working tree. */
export const WORKSPACE_CONTAINMENT =
  'WORKSPACE CONTAINMENT: your workspace is exactly this repository checkout (your current working ' +
  'directory). Every path in the task is relative to it. Never read from, cd into, or modify any other ' +
  'checkout of this project — including the git origin this clone points at. Verify with `pwd` before ' +
  'running suite commands.'

const here = import.meta.dir
export const repoRoot = resolve(here, '..', '..')
const corpusDir = join(here, 'corpus')
export const CORPUS_TAG = 'bench-corpus-v1'
// The corpus base is a COMMIT: every clone pins this sha directly, so the
// label above is a name for humans and receipts, never a ref the bench must
// resolve (tags are deletable bookmarks; the commit is reachable from main).
export const CORPUS_COMMIT = '7901eb241f265055a8ac7c31bee340c7c58751fa'

// ── corpus load + digest ─────────────────────────────────────────────────────
export function loadCorpus(): { tasks: CorpusTask[]; sha256: string } {
  const files = readdirSync(corpusDir).filter(f => f.endsWith('.json')).sort()
  const tasks: CorpusTask[] = []
  const h = createHash('sha256')
  for (const f of files) {
    const raw = readFileSync(join(corpusDir, f), 'utf-8')
    h.update(f).update('\0').update(raw)
    tasks.push(JSON.parse(raw) as CorpusTask)
  }
  return { tasks, sha256: h.digest('hex') }
}

export function judgeChecks(task: CorpusTask, cwd: string): { passed: number; total: number } {
  let passed = 0
  for (const c of task.successChecks) {
    try {
      if (c.kind === 'cmd') {
        execFileSync('bash', ['-lc', c.cmd], { cwd, stdio: 'pipe', timeout: 300_000 })
        passed++
      } else {
        const text = readFileSync(join(cwd, c.file), 'utf-8')
        if (new RegExp(c.pattern, c.flags).test(text)) passed++
      }
    } catch {
      // failed check — counted by omission
    }
  }
  return { passed, total: task.successChecks.length }
}

// ── child env: scrubbed shipped-defaults + exactly our vars ─────────────────
/** Session HERMES_ and TF_ experiment overrides, model/effort/team leaks — all
 *  dropped so children run SHIPPED defaults plus exactly `extra`. */
export function benchChildEnv(
  cfgDir: string,
  extra: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (scrubbedEnvKey(k)) continue
    env[k] = v
  }
  env.MERCURY_CONFIG_DIR = cfgDir
  // DESKTOP CONTAINMENT (P2 calibration #2, live): a child's agent ran the TUI
  // render proof, whose PTY-driven Mercury booted an EMPTY scratch config →
  // login screen → startOAuthFlow AUTO-OPENED the operator's browser on every
  // vshot retry. openBrowser() honors BROWSER as the opener command, so
  // /usr/bin/true makes any descendant's browser-open a silent no-op — a bench
  // child must never be able to pop the operator's desktop.
  env.BROWSER = '/usr/bin/true'
  Object.assign(env, extra)
  return env
}
export function scrubbedEnvKey(k: string): boolean {
  if (/^(MERCURY_|HERMES_|TF_|CLAUDE_)/.test(k)) return true
  if (k === 'ANTHROPIC_MODEL' || k === 'MERCURY_CONFIG_DIR') return true
  return false
}

// ── per-task clone at the pinned corpus SHA ──────────────────────────────────
export function cloneAtSha(dir: string, sha: string): void {
  execFileSync('git', ['clone', '--quiet', repoRoot, dir], { stdio: 'pipe' })
  // Pin the lane base: createAgentWorktree bases new lanes on origin/<default>
  // of the canonical root — inside the clone that ref is OURS to fix.
  execFileSync('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/main', sha], { stdio: 'pipe' })
  // MECHANICAL containment (calibration #2: the solo agent followed the
  // clone's origin URL back to the operator's working tree and did the task
  // THERE): neuter the origin URL — keeps refs/remotes/origin/* (the lane-base
  // pin above) but kills path discovery via `git remote` AND any accidental
  // `git push origin` into the operator's repo. Nothing in a bench run needs
  // the URL: lanes base on the pinned LOCAL ref, no fetches happen.
  execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', 'bench://neutered'], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, 'checkout', '--quiet', '--detach', sha], { stdio: 'pipe' })
  // successChecks run suites in the clone → they need dependencies, and some
  // proofs need the built dist — a real workspace of this repo always has
  // both, so the clone gets them too. APFS clonefile copy is instant + CoW;
  // fall back to a symlink (read-only use).
  for (const name of ['node_modules', 'dist']) {
    const src = join(repoRoot, name)
    const dst = join(dir, name)
    if (!existsSync(src) || existsSync(dst)) continue
    try {
      execFileSync('cp', ['-c', '-R', src, dst], { stdio: 'pipe' })
    } catch {
      try {
        cpSync(src, dst, { recursive: true })
      } catch {
        symlinkSync(src, dst)
      }
    }
  }
}

// ── credential seeding for scratch config dirs ──────────────────────────────
// The macOS keychain entry is CONFIG-DIR-HASHED (macOsKeychainHelpers.ts), so a
// scratch MERCURY_CONFIG_DIR can never see the operator's default entry — the
// probe returned "Not logged in". The secure-storage read chain
// falls back to <configDir>/.credentials.json, so we extract the default
// keychain payload and seed each scratch dir with it (0600), scrubbing the
// file again right after the task. An env-key setup (ANTHROPIC_API_KEY /
// ANTHROPIC_AUTH_TOKEN) needs no seeding — those pass through benchChildEnv.
//
// Read FRESH on every call — NO run-lifetime cache: the p1gu1u shakedown
// cached the payload at run start, and 62 minutes in the access token had
// expired — task 8's child died in 2s ("API Error: 401") and every routed
// seat idled dead. The operator's live sessions keep the keychain entry
// young; with ≤15m timeboxes a fresh sub-hour token also never needs an
// in-child refresh (no rotation risk from token copies).
export function readDefaultCredentialPayload(): string | null {
  if (process.platform !== 'darwin') return null
  const user = process.env.USER ?? ''
  for (const svc of [['Claude', 'Code-credentials'].join(' '), ['Claude', 'Code'].join(' ')]) {
    try {
      const out = execFileSync('security', ['find-generic-password', '-a', user, '-s', svc, '-w'], { stdio: 'pipe' })
        .toString()
        .trim()
      if (out.length > 0) return out
    } catch {
      // try the next service name
    }
  }
  return null
}
export function seedCredentials(cfgDir: string): void {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return // env auth passes through
  const payload = readDefaultCredentialPayload()
  if (!payload) {
    throw new Error('no credentials to seed (no keychain payload, no ANTHROPIC_API_KEY) — children would all fail "Not logged in"')
  }
  const p = join(cfgDir, '.credentials.json')
  writeFileSync(p, payload, { mode: 0o600 })
}
export function scrubCredentials(cfgDir: string): void {
  try {
    rmSync(join(cfgDir, '.credentials.json'), { force: true })
  } catch {
    // best-effort hygiene
  }
}

/** Start-of-run sweep: a KILLED runner never reaches its per-task scrub (the
 *  401-wave kill left 3 seeded payloads; the P2 runner's first
 *  version left 6 more) — so every runner start cleans ALL prior residue
 *  under .claude/bench before seeding anything new. Bounded walk, exact
 *  filename only. */
export function scrubLingeringBenchCredentials(): number {
  const benchRoot = join(repoRoot, '.claude', 'bench')
  let removed = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.name === '.credentials.json') {
        try {
          rmSync(p, { force: true })
          removed++
        } catch {
          // best-effort hygiene
        }
      }
    }
  }
  walk(benchRoot, 0)
  return removed
}
