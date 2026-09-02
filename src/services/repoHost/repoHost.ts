// ============================================================================
//  repoHost — repository-host context as bounded local reads over
//  the ALREADY CONFIGURED GitHub CLI session, plus the typed review record.
//
//  Laws:
//    · OBSERVATIONAL ONLY — this module can never push, merge, comment or
//      mutate host state; every gh invocation is a read (view/checks/api
//      GET) with a hard timeout and bounded output;
//    · no remote-session store, no background synchronizer — one in-memory
//      TTL cache (30s) per query is the only retention;
//    · unavailability is EXACT: gh missing, gh unauthenticated, not a
//      repo, no upstream/PR, malformed CLI output each name themselves and
//      their remedy — never optimistic prose;
//    · the review record is typed and validated: findings carry class
//      (defect | question | polish) · severity · exact path+range — a path
//      outside the reviewed diff set REFUSES (a review can never invent
//      file locations); an empty-findings review must name what it
//      inspected. Durable under <root>/.mercury/reviews/ via
//      durableAtomicPublish; served at mercury://repo/review/latest.
//
//  Gate: MERCURY_REPO_HOST (default-ON) — `=0` removes the resource kind and
//  every gh read; the local Git owner is untouched.
//
//  Proof: scripts/edit-tools/prove-repo-host.ts (deterministic gh shim; a live
//  gh read is a journey receipt, never a gate dependency).
// ============================================================================

import { adoptiveProjectPath } from '../../utils/projectStoreAdoption.js'
import { execFile } from 'node:child_process'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { durableAtomicPublish } from '../../substrate/durablePublish.js'
import { getCwd } from '../../utils/cwd.js'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { gitDiff, gitStatus, isGitRepo } from '../gitGraph/observe.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

/** The S5 gate (re-read live). */
export function repoHostEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_REPO_HOST'))
}

const GH_TIMEOUT_MS = 15_000
const MAX_GH_BYTES = 2 * 1024 * 1024
const CACHE_TTL_MS = 30_000
const BODY_CAP = 4_000
const FILE_CAP = 60
const CHECK_CAP = 40

type Unavailable = { state: 'unavailable'; note: string; remedy: string }
type GhOk = { state: 'ok'; stdout: string }

// Family 2: the ONE cache gains generation awareness — identical
// concurrent queries SHARE one in-flight gh call, and a slower OLDER
// completion can never overwrite a newer stored value (latest-request-wins;
// watch polls run `fresh` and race cached reads on the same key).
const cache = new Map<string, { at: number; gen: number; value: GhOk | Unavailable }>()
const inFlight = new Map<string, Promise<GhOk | Unavailable>>()
let ghGeneration = 0

export function _resetRepoHostCacheForTesting(): void {
  cache.clear()
  inFlight.clear()
}

async function gh(
  root: string,
  args: string[],
  opts: { fresh?: boolean } = {},
): Promise<GhOk | Unavailable> {
  const key = JSON.stringify([root, ...args])
  if (!opts.fresh) {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
    const pending = inFlight.get(key)
    if (pending) return pending
  }
  const gen = ++ghGeneration
  const run = new Promise<GhOk | Unavailable>(resolve => {
    execFile(
      'gh',
      args,
      { windowsHide: true, cwd: root, timeout: GH_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: MAX_GH_BYTES, env: { ...subprocessEnv() } },
      (err, stdout, stderr) => {
        if (err) {
          const enoent = (err as NodeJS.ErrnoException).code === 'ENOENT'
          resolve({
            state: 'unavailable',
            note: enoent
              ? 'the GitHub CLI (gh) is not on PATH'
              : `gh ${args[0]} ${args[1] ?? ''} failed: ${(stderr || err.message).trim().slice(0, 200)}`,
            remedy: enoent
              ? 'install the GitHub CLI and authenticate (gh auth login)'
              : 'check gh auth status and that this branch/PR exists on the host',
          })
          return
        }
        resolve({ state: 'ok', stdout: stdout ?? '' })
      },
    )
  }).then(value => {
    const existing = cache.get(key)
    if (!existing || existing.gen <= gen) cache.set(key, { at: Date.now(), gen, value })
    if (inFlight.get(key) === run) inFlight.delete(key)
    return value
  })
  if (!opts.fresh) inFlight.set(key, run)
  return run
}

function parseJson<T>(raw: string, what: string): { state: 'ok'; data: T } | Unavailable {
  try {
    return { state: 'ok', data: JSON.parse(raw) as T }
  } catch {
    return {
      state: 'unavailable',
      note: `${what}: gh returned unparseable output (${raw.trim().slice(0, 80)}…)`,
      remedy: 'upgrade gh or retry — the CLI contract drifted',
    }
  }
}

// ── typed host reads ────────────────────────────────────────────────────────

export interface PrSummary {
  number: number
  title: string
  state: string
  baseRefName: string
  headRefName: string
  url?: string
  body: string
  files: Array<{ path: string; additions: number; deletions: number }>
  filesTruncated: number
}

export async function fetchPr(
  root: string,
  n?: number,
): Promise<{ state: 'ok'; pr: PrSummary } | Unavailable> {
  const args = ['pr', 'view', ...(n !== undefined ? [String(n)] : []), '--json', 'number,title,state,baseRefName,headRefName,url,body,files']
  const out = await gh(root, args)
  if (out.state !== 'ok') return out
  const parsed = parseJson<Record<string, unknown>>(out.stdout, 'pr view')
  if (parsed.state !== 'ok') return parsed
  const d = parsed.data
  const files = Array.isArray(d.files) ? (d.files as Array<{ path: string; additions?: number; deletions?: number }>) : []
  return {
    state: 'ok',
    pr: {
      number: Number(d.number ?? n ?? 0),
      title: String(d.title ?? ''),
      state: String(d.state ?? 'UNKNOWN'),
      baseRefName: String(d.baseRefName ?? ''),
      headRefName: String(d.headRefName ?? ''),
      ...(d.url ? { url: String(d.url) } : {}),
      body: String(d.body ?? '').slice(0, BODY_CAP),
      files: files.slice(0, FILE_CAP).map(f => ({ path: String(f.path), additions: Number(f.additions ?? 0), deletions: Number(f.deletions ?? 0) })),
      filesTruncated: Math.max(0, files.length - FILE_CAP),
    },
  }
}

export interface IssueSummary {
  number: number
  title: string
  state: string
  url?: string
  body: string
}

export async function fetchIssue(
  root: string,
  n: number,
): Promise<{ state: 'ok'; issue: IssueSummary } | Unavailable> {
  const out = await gh(root, ['issue', 'view', String(n), '--json', 'number,title,state,url,body'])
  if (out.state !== 'ok') return out
  const parsed = parseJson<Record<string, unknown>>(out.stdout, 'issue view')
  if (parsed.state !== 'ok') return parsed
  const d = parsed.data
  return {
    state: 'ok',
    issue: {
      number: Number(d.number ?? n),
      title: String(d.title ?? ''),
      state: String(d.state ?? 'UNKNOWN'),
      ...(d.url ? { url: String(d.url) } : {}),
      body: String(d.body ?? '').slice(0, BODY_CAP),
    },
  }
}

export interface CheckRow {
  name: string
  status: string
  duration?: string
  link?: string
}

/** `gh pr checks` is TSV-ish (name\tstatus\tduration\tlink). Bounded parse;
 *  rows that do not split are kept as opaque name-only rows (never dropped
 *  silently, never invented). */
export async function fetchChecks(
  root: string,
  n?: number,
): Promise<{ state: 'ok'; checks: CheckRow[]; truncated: number } | Unavailable> {
  const out = await gh(root, ['pr', 'checks', ...(n !== undefined ? [String(n)] : [])])
  if (out.state !== 'ok') return out
  const lines = out.stdout.split('\n').filter(l => l.trim().length > 0)
  const rows: CheckRow[] = lines.map(line => {
    const parts = line.split('\t')
    if (parts.length >= 2) {
      return {
        name: parts[0]!.trim(),
        status: parts[1]!.trim(),
        ...(parts[2] ? { duration: parts[2].trim() } : {}),
        ...(parts[3] ? { link: parts[3].trim() } : {}),
      }
    }
    return { name: line.trim(), status: 'unparsed' }
  })
  return { state: 'ok', checks: rows.slice(0, CHECK_CAP), truncated: Math.max(0, rows.length - CHECK_CAP) }
}

// ── the typed review record ─────────────────────────────────────────────────

export interface ReviewFinding {
  /** verified defect · open question · non-blocking polish */
  class: 'defect' | 'question' | 'polish'
  severity: 'blocker' | 'major' | 'minor'
  path: string
  /** 'L<start>' or 'L<start>-L<end>' — 1-based. */
  range: string
  claim: string
  evidence: string
  nextAction: string
}

export interface ReviewRecord {
  schema: 1
  id: string
  at: number
  scope: string
  inspected: string[]
  findings: ReviewFinding[]
  note?: string
}

function reviewsDir(root: string): string {
  // Sticky at the STORE ROOT: an existing home's reviews stay
  // in place; a fresh project creates under .mercury (never a leaf-sticky —
  // sub-paths join AFTER resolution).
  return adoptiveProjectPath(root, 'reviews')
}

export function latestReview(root: string = getCwd()): ReviewRecord | null {
  try {
    return JSON.parse(readFileSync(path.join(reviewsDir(root), 'latest.json'), 'utf8')) as ReviewRecord
  } catch {
    return null
  }
}

export type RecordReviewOutcome =
  | { state: 'ok'; record: ReviewRecord }
  | { state: 'refused'; reason: string }

/**
 * Validate + persist a review. `allowedPaths` is the reviewed diff's file
 * set — a finding naming any other path refuses (locations are never
 * invented). An empty-findings review must say what it inspected.
 */
export async function recordReview(opts: {
  root?: string
  scope: string
  inspected: string[]
  findings: ReviewFinding[]
  allowedPaths: string[]
  note?: string
}): Promise<RecordReviewOutcome> {
  const root = opts.root ?? getCwd()
  if (opts.findings.length === 0 && opts.inspected.length === 0) {
    return { state: 'refused', reason: 'an empty review must name what it inspected (inspected: [])' }
  }
  const allowed = new Set(opts.allowedPaths)
  for (let i = 0; i < opts.findings.length; i++) {
    const f = opts.findings[i]!
    if (!allowed.has(f.path)) {
      return {
        state: 'refused',
        reason: `finding ${i + 1} names '${f.path}' which is not in the reviewed set (${opts.allowedPaths.slice(0, 8).join(', ')}${opts.allowedPaths.length > 8 ? ', …' : ''}) — reviews never invent locations`,
      }
    }
    if (!/^L\d+(-L?\d+)?$/.test(f.range)) {
      return { state: 'refused', reason: `finding ${i + 1}: range '${f.range}' must be 'L<start>' or 'L<start>-L<end>'` }
    }
    if (!f.claim.trim() || !f.evidence.trim() || !f.nextAction.trim()) {
      return { state: 'refused', reason: `finding ${i + 1}: claim, evidence and nextAction are all required` }
    }
  }
  const record: ReviewRecord = {
    schema: 1,
    id: `rev-${Date.now()}-${randomBytes(3).toString('hex')}`,
    at: Date.now(),
    scope: opts.scope,
    inspected: opts.inspected.slice(0, 100),
    findings: opts.findings.slice(0, 50),
    ...(opts.note ? { note: opts.note.slice(0, 500) } : {}),
  }
  const dir = reviewsDir(root)
  await durableAtomicPublish(path.join(dir, `${record.id}.json`), JSON.stringify(record, null, 2) + '\n')
  await durableAtomicPublish(path.join(dir, 'latest.json'), JSON.stringify(record, null, 2) + '\n')
  return { state: 'ok', record }
}

// ── the compact review context (the composition, not a second store) ───────

export interface ReviewContext {
  scope: 'worktree' | `pr#${number}`
  root: string
  files: Array<{ path: string; additions: number; deletions: number }>
  hunkCount: number
  truncated: boolean
  prTitle?: string
  prBody?: string
  impactRef: string
  diagnosticsNote: string
  unavailable: string[]
}

export async function composeReviewContext(
  from: string = getCwd(),
  opts: { pr?: number } = {},
): Promise<{ state: 'ok'; context: ReviewContext } | Unavailable> {
  const root = from
  if (!isGitRepo(root)) {
    return { state: 'unavailable', note: 'not a git repository', remedy: 'run inside a checkout' }
  }
  const unavailable: string[] = []
  let files: ReviewContext['files'] = []
  let hunkCount = 0
  let truncated = false
  let prTitle: string | undefined
  let prBody: string | undefined
  let scope: ReviewContext['scope'] = 'worktree'

  if (opts.pr !== undefined && repoHostEnabled()) {
    const pr = await fetchPr(root, opts.pr)
    if (pr.state === 'ok') {
      scope = `pr#${pr.pr.number}`
      files = pr.pr.files
      prTitle = pr.pr.title
      prBody = pr.pr.body
    } else {
      return pr
    }
  } else {
    if (opts.pr !== undefined) unavailable.push('repository host disabled (MERCURY_REPO_HOST=0) — reviewed the worktree instead')
    const d = gitDiff(root, { scope: 'worktree' })
    if ('state' in d && d.state === 'unavailable') {
      return { state: 'unavailable', note: d.note ?? 'diff unavailable', remedy: 'check the repository state' }
    }
    const diff = d as Exclude<typeof d, { state: string }>
    files = diff.files.map(f => ({ path: f.path, additions: f.additions, deletions: f.deletions }))
    hunkCount = diff.hunks.length
    truncated = diff.truncated
  }

  // Impact: a REF, never a body (the capsule law)
  let impactRef = 'mercury://project/impact (project intelligence disabled)'
  try {
    const { projectIntelEnabled } =
      require('../projectIntel/contracts.js') as { projectIntelEnabled?: () => boolean }
    if (projectIntelEnabled?.()) impactRef = 'mercury://project/impact'
    else unavailable.push('project-intel impact (MERCURY_PROJECT_INTEL=0)')
  } catch {
    unavailable.push('project-intel impact (owner not loadable)')
  }

  let diagnosticsNote = 'no live diagnostics provider'
  try {
    const { getPendingLSPDiagnosticCount } =
      require('../lsp/LSPDiagnosticRegistry.js') as typeof import('../lsp/LSPDiagnosticRegistry.js')
    const pending = getPendingLSPDiagnosticCount()
    diagnosticsNote = `${pending} pending LSP diagnostic(s)`
  } catch {
    /* keep the honest default */
  }

  return {
    state: 'ok',
    context: {
      scope,
      root,
      files,
      hunkCount,
      truncated,
      ...(prTitle !== undefined ? { prTitle } : {}),
      ...(prBody !== undefined ? { prBody } : {}),
      impactRef,
      diagnosticsNote,
      unavailable,
    },
  }
}

/** Local repo summary for the adapter root resource (host-free). */
export function localRepoSummary(root: string = getCwd()): {
  state: 'ok'
  branch: string
  head: string
  upstream?: string
  ahead?: number
  behind?: number
  clean: boolean
} | Unavailable {
  const s = gitStatus(root)
  if ('state' in s && s.state === 'unavailable') {
    return { state: 'unavailable', note: s.note ?? 'not a git repository', remedy: 'run inside a checkout' }
  }
  const st = s as Exclude<typeof s, { state: string }>
  return {
    state: 'ok',
    branch: st.branch,
    head: st.head,
    ...(st.upstream ? { upstream: st.upstream, ahead: st.ahead, behind: st.behind } : {}),
    clean: st.clean,
  }
}

// ── Family 2: bounded host searches (observation-only) ────────────────

export type HostSearchKind = 'code' | 'commits' | 'prs' | 'issues'

export interface HostSearchRow {
  title: string
  repo: string
  url?: string
  detail?: string
}

const SEARCH_LIMIT_MAX = 50
const SEARCH_LIMIT_DEFAULT = 10

/**
 * Typed `gh search <kind>` (code · commits · prs · issues) — bounded rows,
 * concise projections. Search never mutates host state.
 */
export async function searchHost(
  root: string,
  kind: HostSearchKind,
  query: string,
  limit?: number,
): Promise<{ state: 'ok'; kind: HostSearchKind; rows: HostSearchRow[] } | Unavailable> {
  if (!query.trim()) {
    return { state: 'unavailable', note: 'an empty search query', remedy: 'pass a query (GitHub search syntax works)' }
  }
  const n = Math.min(Math.max(limit ?? SEARCH_LIMIT_DEFAULT, 1), SEARCH_LIMIT_MAX)
  const fields: Record<HostSearchKind, string> = {
    code: 'path,repository,url',
    commits: 'sha,commit,repository,url',
    prs: 'number,title,state,repository,url',
    issues: 'number,title,state,repository,url',
  }
  const out = await gh(root, ['search', kind, query, '--json', fields[kind], '--limit', String(n)])
  if (out.state !== 'ok') return out
  const parsed = parseJson<Array<Record<string, unknown>>>(out.stdout, `search ${kind}`)
  if (parsed.state !== 'ok') return parsed
  if (!Array.isArray(parsed.data)) {
    return { state: 'unavailable', note: `search ${kind}: gh returned a non-array`, remedy: 'upgrade gh — the CLI contract drifted' }
  }
  const repoOf = (d: Record<string, unknown>): string => {
    const repo = d.repository as { nameWithOwner?: string; fullName?: string } | undefined
    return repo?.nameWithOwner ?? repo?.fullName ?? ''
  }
  const rows: HostSearchRow[] = parsed.data.slice(0, n).map(d => {
    switch (kind) {
      case 'code':
        return { title: String(d.path ?? ''), repo: repoOf(d), ...(d.url ? { url: String(d.url) } : {}) }
      case 'commits': {
        const commit = d.commit as { message?: string } | undefined
        return {
          title: String(commit?.message ?? '').split('\n')[0]!.slice(0, 120),
          repo: repoOf(d),
          detail: String(d.sha ?? '').slice(0, 12),
          ...(d.url ? { url: String(d.url) } : {}),
        }
      }
      case 'prs':
      case 'issues':
        return {
          title: `#${d.number} ${String(d.title ?? '')}`.slice(0, 140),
          repo: repoOf(d),
          detail: String(d.state ?? ''),
          ...(d.url ? { url: String(d.url) } : {}),
        }
    }
  })
  return { state: 'ok', kind, rows }
}

// ── Family 2: paginated per-file PR diff (ONE gh fetch per TTL) ───────

export interface PrDiffFileRow {
  index: number
  path: string
  additions: number
  deletions: number
  hunks: number
}

const DIFF_PAGE_LINES = 80

/** The changed-file list of a PR's diff — the pagination index. `bounded`
 *  is the parse-cap honesty flag: the underlying parse holds ≤200 hunks of
 *  ≤120 lines — a bounded listing must SAY so, never claim completeness. */
export async function fetchPrDiffFiles(
  root: string,
  n?: number,
): Promise<{ state: 'ok'; files: PrDiffFileRow[]; totalFiles: number; bounded: boolean } | Unavailable> {
  const out = await gh(root, ['pr', 'diff', ...(n !== undefined ? [String(n)] : [])])
  if (out.state !== 'ok') return out
  const { parseUnifiedDiff } = await import('../gitGraph/observe.js')
  const parsed = parseUnifiedDiff(out.stdout)
  const files = parsed.files.slice(0, FILE_CAP).map((f, i) => ({
    index: i,
    path: f.path,
    additions: f.additions,
    deletions: f.deletions,
    hunks: parsed.hunks.filter(h => h.file === f.path).length,
  }))
  return { state: 'ok', files, totalFiles: parsed.files.length, bounded: parsed.truncated }
}

/**
 * One PAGE of one file's diff (deterministic: DIFF_PAGE_LINES-line pages
 * over that file's hunks, in order). The same TTL row serves the file list
 * and every page — one host fetch, many bounded reads.
 */
export async function fetchPrDiffPage(
  root: string,
  file: string,
  page = 0,
  n?: number,
): Promise<
  | {
      state: 'ok'
      file: string
      page: number
      pages: number
      lines: string[]
      additions: number
      deletions: number
      /** Set when the parse caps bounded THIS file's hunks — the pages do
       *  not carry the whole diff; the note names the local remedy. */
      incompleteNote?: string
    }
  | Unavailable
> {
  const out = await gh(root, ['pr', 'diff', ...(n !== undefined ? [String(n)] : [])])
  if (out.state !== 'ok') return out
  const { parseUnifiedDiff } = await import('../gitGraph/observe.js')
  const parsed = parseUnifiedDiff(out.stdout)
  const fileRow = parsed.files.find(f => f.path === file)
  if (!fileRow) {
    return {
      state: 'unavailable',
      note: `'${file}' is not in this PR's diff`,
      remedy: 'pick a path from the diff file list (Git op:"prDiff" without file)',
    }
  }
  const lines = parsed.hunks
    .filter(h => h.file === file)
    .flatMap(h => [h.header, ...h.lines])
  // Parse-cap honesty: the counted +/− from the RAW diff vs what the
  // bounded hunks reconstruct — a shortfall must never read as complete.
  const reconstructed = lines.filter(l => l.startsWith('+') || l.startsWith('-')).length
  const incomplete = parsed.truncated && reconstructed < fileRow.additions + fileRow.deletions
  const pages = Math.max(1, Math.ceil(lines.length / DIFF_PAGE_LINES))
  const wanted = Math.min(Math.max(page, 0), pages - 1)
  return {
    state: 'ok',
    file,
    page: wanted,
    pages,
    lines: lines.slice(wanted * DIFF_PAGE_LINES, (wanted + 1) * DIFF_PAGE_LINES),
    additions: fileRow.additions,
    deletions: fileRow.deletions,
    ...(incomplete
      ? {
          incompleteNote: `the bounded parse carries ${reconstructed} of ${fileRow.additions + fileRow.deletions} changed line(s) for this file — for the full diff use local git (fetch the PR head, then Git op:"diff" scope:"range")`,
        }
      : {}),
  }
}

// ── Family 2: workflow-run status (observation-only) ──────────────────

export interface RunRow {
  id: string
  title: string
  workflow: string
  status: string
  conclusion: string
  branch: string
  createdAt: string
  url?: string
}

const RUNS_LIMIT_MAX = 20

export async function fetchRuns(
  root: string,
  limit?: number,
): Promise<{ state: 'ok'; runs: RunRow[] } | Unavailable> {
  const n = Math.min(Math.max(limit ?? 10, 1), RUNS_LIMIT_MAX)
  const out = await gh(root, [
    'run',
    'list',
    '--json',
    'databaseId,displayTitle,workflowName,status,conclusion,headBranch,createdAt,url',
    '--limit',
    String(n),
  ])
  if (out.state !== 'ok') return out
  const parsed = parseJson<Array<Record<string, unknown>>>(out.stdout, 'run list')
  if (parsed.state !== 'ok') return parsed
  return {
    state: 'ok',
    runs: (Array.isArray(parsed.data) ? parsed.data : []).slice(0, n).map(d => ({
      id: String(d.databaseId ?? ''),
      title: String(d.displayTitle ?? '').slice(0, 120),
      workflow: String(d.workflowName ?? ''),
      status: String(d.status ?? ''),
      conclusion: String(d.conclusion ?? ''),
      branch: String(d.headBranch ?? ''),
      createdAt: String(d.createdAt ?? ''),
      ...(d.url ? { url: String(d.url) } : {}),
    })),
  }
}

export interface RunView {
  id: string
  title: string
  workflow: string
  status: string
  conclusion: string
  jobs: Array<{ name: string; status: string; conclusion: string }>
  url?: string
}

const RUN_JOB_CAP = 20

export async function fetchRun(
  root: string,
  id: string,
  opts: { fresh?: boolean } = {},
): Promise<{ state: 'ok'; run: RunView } | Unavailable> {
  const out = await gh(
    root,
    ['run', 'view', id, '--json', 'databaseId,displayTitle,workflowName,status,conclusion,jobs,url'],
    opts,
  )
  if (out.state !== 'ok') return out
  const parsed = parseJson<Record<string, unknown>>(out.stdout, 'run view')
  if (parsed.state !== 'ok') return parsed
  const d = parsed.data
  const jobs = Array.isArray(d.jobs) ? (d.jobs as Array<Record<string, unknown>>) : []
  return {
    state: 'ok',
    run: {
      id: String(d.databaseId ?? id),
      title: String(d.displayTitle ?? '').slice(0, 120),
      workflow: String(d.workflowName ?? ''),
      status: String(d.status ?? ''),
      conclusion: String(d.conclusion ?? ''),
      jobs: jobs.slice(0, RUN_JOB_CAP).map(j => ({
        name: String(j.name ?? ''),
        status: String(j.status ?? ''),
        conclusion: String(j.conclusion ?? ''),
      })),
      ...(d.url ? { url: String(d.url) } : {}),
    },
  }
}
