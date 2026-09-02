// ============================================================================
//  scripts/lib/git.ts — the ONE typed fixed-tool Git executor for script-land
//
//
//  Executable + argument vector IS DATA: revisions like `${sha}^{tree}` ride
//  as one argv element, so cmd.exe (which eats `^`), PowerShell, Bash,
//  quoting, path spaces, and locale can never rewrite the caller's intent —
//  the F1 field defect where verify:fast's string-shell helper lost every
//  reachable green anchor on Windows.
//
//  FAILURE IS NOT EMPTY OUTPUT: every way a git call can fail stays a
//  distinct typed state. Callers BRANCH; a caller that deliberately fails
//  soft does so after recording which state it saw — never through a
//  `catch { return '' }` that makes "git is broken" and "no anchors exist"
//  the same verdict. Modeled on scripts/gate/ledger.ts's execFileSync shape
//  (the correct pattern this repo already carried).
// ============================================================================
import { spawnSync } from 'node:child_process'

export type GitResult =
  | { state: 'ok'; stdout: string }
  | { state: 'unavailable'; detail: string }
  | { state: 'nonzero'; code: number; stderr: string }
  | { state: 'timeout' }
  | { state: 'malformed'; detail: string }

export interface RunGitOptions {
  cwd?: string
  timeoutMs?: number
  maxBuffer?: number
  /** Fixture seam: pin the child env (e.g. an empty PATH proves the
   *  `unavailable` arm without uninstalling git). Omitted ⇒ inherit. */
  env?: NodeJS.ProcessEnv
}

/** Run git with an argument vector and return the full typed result. */
export function runGit(args: string[], opts: RunGitOptions = {}): GitResult {
  const r = spawnSync('git', args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    timeout: opts.timeoutMs,
    maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
    ...(opts.env ? { env: opts.env } : {}),
  })
  if (r.error) {
    const err = r.error as NodeJS.ErrnoException
    if (err.code === 'ETIMEDOUT') return { state: 'timeout' }
    return { state: 'unavailable', detail: `${err.code ?? 'ERR'}: ${err.message}` }
  }
  if (r.signal) {
    // A watchdog/timeout kill lands here on some platforms (SIGTERM without
    // error.code) — still a timeout class, never an empty success.
    return { state: 'timeout' }
  }
  if (typeof r.status === 'number' && r.status !== 0) {
    return { state: 'nonzero', code: r.status, stderr: (r.stderr ?? '').trim() }
  }
  if (typeof r.stdout !== 'string') {
    return { state: 'malformed', detail: 'no stdout captured' }
  }
  return { state: 'ok', stdout: r.stdout }
}

/** Convenience for "resolve or explain": RAW stdout on ok, else null — with
 *  the typed state handed to `onMiss` so the caller RECORDS why before
 *  failing soft (the L17 contract; silence is not an option this API offers).
 *  RAW deliberately: porcelain-class output is column-structured, and a
 *  wholesale trim eats the leading status column of the first line
 *  (` M path` → `M path` → a one-character path corruption — caught live by
 *  the slice-e2e estate during the close train). Single-token
 *  consumers trim at their own call sites. */
export function gitOutOrNull(
  args: string[],
  opts: RunGitOptions & { onMiss: (miss: Exclude<GitResult, { state: 'ok' }>) => void },
): string | null {
  const r = runGit(args, opts)
  if (r.state === 'ok') return r.stdout
  opts.onMiss(r)
  return null
}
