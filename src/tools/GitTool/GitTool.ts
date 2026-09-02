// ============================================================================
//  Git tool — the typed local work-graph surface.
//  Observation: status · diff (bounded hunks with stable ids) · show ·
//  worktree · conflicts · mergebase. Transactions: preview-first atomic
//  commit PLANS (prepare → stale-safe apply, one evidence-backed
//  transaction per created commit) · exact file/hunk staging · index-only
//  restore · conflict resolution · plan verification.
//
//  LAWS: local only — never push, never fetch, never rewrite history,
//  never discard uncommitted content. Ordinary Bash git stays available;
//  this surface exists for structured, inspectable, verifiable operations.
//
//  Gate: MERCURY_GIT_GRAPH (default-on, registered).
//  Proofs: scripts/builtin-tools/prove-git-graph.ts · prove-git-plans.ts ·
//          the artifact circuit.
// ============================================================================

import { z } from 'zod/v4'
import * as path from 'node:path'
import { buildTool, type ToolEffectOutcome, type ToolUseContext } from '../../Tool.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { gitGraphEnabled, type GitPlanGroup } from '../../services/gitGraph/contracts.js'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

// The repoHost gate, read at MODULE LOAD for the discovery surface only
// (runtime refusals re-read env live via repoHostEnabled()). A local
// helper: importing repoHost.ts here would defeat its lazy loading.
function repoHostDiscoveryEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_REPO_HOST'))
}
import {
  gitCommitMeta,
  gitConflicts,
  gitDiff,
  gitMergeBase,
  gitStatus,
  gitWorktrees,
} from '../../services/gitGraph/observe.js'
import { maybeExpandFilePath } from '../../utils/fileHistory.js'
import {
  applyPlan,
  preparePlan,
  resolveConflict,
  restoreStaged,
  stageSelection,
  verifyPlan,
} from '../../services/gitGraph/plan.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

const OPS = [
  'status',
  'diff',
  'show',
  'worktree',
  'conflicts',
  'mergebase',
  'plan',
  'apply',
  'stage',
  'restore',
  'resolve',
  'verify',
  'reviewContext',
  'reviewRecord',
  // Family 2 — local at-ref observation:
  'fileAtRef',
  'tree',
  'compare',
  // Family 2 — host observation (MERCURY_REPO_HOST; read-only):
  'hostSearch',
  'prDiff',
  'runs',
  'runWatch',
] as const

// The typed review finding (verified defect · question · polish)
const findingSchema = () =>
  z.strictObject({
    class: z.enum(['defect', 'question', 'polish']).describe('verified defect · open question · non-blocking polish'),
    severity: z.enum(['blocker', 'major', 'minor']),
    path: z.string().describe('exact repo-relative path INSIDE the reviewed diff set'),
    range: z.string().describe("'L<start>' or 'L<start>-L<end>' (1-based)"),
    claim: z.string().describe('one-sentence statement of the finding'),
    evidence: z.string().describe('concise evidence backing the claim'),
    nextAction: z.string().describe('the proposed next action'),
  })

const groupSchema = () =>
  z.strictObject({
    files: z.array(z.string()).describe('exact repo-relative paths (a file belongs to at most one group)'),
    hunks: z
      .record(z.string(), z.array(z.string()))
      .optional()
      .describe('optional per-file exact hunk-id subsets (gh-… from op:"diff")'),
    message: z.string().describe('the commit message for this group'),
    checks: z.array(z.string()).optional().describe('checks associated with this group (recorded on the plan)'),
  })

const inputSchema = lazySchema(() =>
  z.strictObject({
    op: z.enum(OPS).describe('The git work-graph operation'),
    scope: z.enum(['worktree', 'staged', 'commit', 'range']).optional().describe('diff: what to diff (default worktree)'),
    ref: z.string().optional().describe("diff: a sha (scope 'commit') or 'A..B' (scope 'range')"),
    paths: z.array(z.string()).optional().describe('diff: limit to these paths'),
    sha: z.string().optional().describe('show: the commit'),
    refA: z.string().optional().describe('mergebase: first ref'),
    refB: z.string().optional().describe('mergebase: second ref'),
    groups: z.array(groupSchema()).optional().describe('plan: the proposed commit groups, in dependency order'),
    planId: z.string().optional().describe('apply/verify: the plan (gp-…)'),
    files: z.array(z.string()).optional().describe('stage/restore: exact repo-relative paths'),
    hunks: z.record(z.string(), z.array(z.string())).optional().describe('stage: per-file exact hunk-id subsets'),
    path: z.string().optional().describe('resolve: the conflicted path'),
    take: z.enum(['ours', 'theirs']).optional().describe('resolve: take one side wholesale'),
    content: z.string().optional().describe('resolve: explicit resolved content (instead of take)'),
    pr: semanticNumber(z.number().int().positive().optional()).describe('reviewContext/prDiff: compose against this PR instead of the current branch (needs the gh session)'),
    findings: z.array(findingSchema()).optional().describe('reviewRecord: the typed findings (empty = an honest no-findings review; inspected required)'),
    inspected: z.array(z.string()).optional().describe('reviewRecord: what was actually inspected (required when findings is empty)'),
    reviewNote: z.string().optional().describe('reviewRecord: optional bounded note'),
    searchKind: z.enum(['code', 'commits', 'prs', 'issues']).optional().describe('hostSearch: what to search on the host'),
    query: z.string().optional().describe('hostSearch: the search query (GitHub search syntax)'),
    limit: semanticNumber(z.number().int().positive().optional()).describe('hostSearch/runs: result bound (search ≤50 default 10 · runs ≤20 default 10)'),
    file: z.string().optional().describe("prDiff: one changed file's path — pages that file's diff (omit for the file list)"),
    page: semanticNumber(z.number().int().nonnegative().optional()).describe('prDiff: 0-based page of the selected file (80 diff lines per page)'),
    run: z.string().optional().describe('runs/runWatch: a workflow-run id (runs: inspect one run · runWatch: the run to watch)'),
    cancel: z.boolean().optional().describe('runWatch: true cancels the live watch for `run` instead of starting one'),
  }),
)

type SchemaType = ReturnType<typeof inputSchema>
export type Input = z.infer<SchemaType>
export type Output = {
  op: Input['op']
  result: string
  outcome: ToolEffectOutcome
}

async function runOp(
  input: Input,
  context: ToolUseContext,
): Promise<{ result: string; outcome: ToolEffectOutcome; changedPaths?: string[] }> {
  const owner = ownerFromToolUseContext(context)
  const root = getCwd()

  switch (input.op) {
    case 'status': {
      const s = gitStatus(root)
      if ('state' in s) return { result: s.note, outcome: 'failed' }
      const rows = s.files
        .slice(0, 40)
        .map(f => `  ${(f.staged || '.') + (f.unstaged || '.')} ${f.kind === 'untracked' ? '?' : f.kind === 'unmerged' ? 'U' : ' '} ${f.path}${f.origPath ? ` (from ${f.origPath})` : ''}`)
      return {
        result: [
          `${s.branch} @ ${s.head.slice(0, 8)}${s.upstream ? ` (${s.upstream} +${s.ahead} -${s.behind})` : ''} · digest ${s.digest}`,
          s.clean ? 'clean' : `${s.files.length} changed file(s):`,
          ...rows,
          ...(s.files.length > 40 ? [`  … +${s.files.length - 40} more (mercury://git/status)`] : []),
          'record: mercury://git/status',
        ].join('\n'),
        outcome: 'no-change',
      }
    }
    case 'diff': {
      const d = gitDiff(root, {
        scope: input.scope ?? 'worktree',
        ...(input.ref !== undefined && { ref: input.ref }),
        ...(input.paths !== undefined && { paths: input.paths }),
      })
      if ('state' in d) return { result: d.note, outcome: 'failed' }
      const fileRows = d.files.slice(0, 30).map(f => `  ${f.path} +${f.additions} -${f.deletions}${f.binary ? ' (binary)' : ''}`)
      const hunkRows = d.hunks.slice(0, 20).map(h => `  ${h.id} ${h.file} ${h.header} (+${h.additions} -${h.deletions})`)
      return {
        result: [
          `${d.scope}${d.ref ? ` ${d.ref}` : ''}: ${d.files.length} file(s), ${d.hunks.length} hunk(s)${d.truncated ? ' · TRUNCATED' : ''}`,
          ...fileRows,
          'hunks (stable ids for plan/stage):',
          ...hunkRows,
          ...(d.hunks.length > 20 ? [`  … +${d.hunks.length - 20} more (mercury://git/diff)`] : []),
        ].join('\n'),
        outcome: 'no-change',
      }
    }
    case 'show': {
      if (!input.sha) return { result: 'show needs sha', outcome: 'failed' }
      const c = gitCommitMeta(root, input.sha)
      if ('state' in c) return { result: c.note, outcome: 'failed' }
      return {
        result: [
          `${c.sha.slice(0, 12)} ${c.subject}`,
          `${c.author} <${c.authorEmail}> · ${c.date} · parents: ${c.parents.map(p => p.slice(0, 8)).join(', ') || '(root)'}`,
          ...c.files.slice(0, 30).map(f => `  ${f.status} ${f.path}`),
          `record: mercury://git/commit/${c.sha}`,
        ].join('\n'),
        outcome: 'no-change',
      }
    }
    case 'worktree': {
      const w = gitWorktrees(root)
      if ('state' in w) return { result: w.note, outcome: 'failed' }
      return {
        result: w.map(t => `  ${t.isMain ? 'main' : '    '} ${t.path} @ ${t.head.slice(0, 8)}${t.branch ? ` (${t.branch})` : ''}`).join('\n'),
        outcome: 'no-change',
      }
    }
    case 'conflicts': {
      const all = gitConflicts(root)
      if ('state' in all) return { result: all.note, outcome: 'failed' }
      if (all.length === 0) return { result: 'no unmerged conflicts', outcome: 'no-change' }
      return {
        result: all
          .map(c => `  ${c.id} ${c.path} (base ${c.base.length}L · ours ${c.ours.length}L · theirs ${c.theirs.length}L) — mercury://git/conflict/${c.id}`)
          .join('\n'),
        outcome: 'no-change',
      }
    }
    case 'mergebase': {
      if (!input.refA || !input.refB) return { result: 'mergebase needs refA + refB', outcome: 'failed' }
      const base = gitMergeBase(root, input.refA, input.refB)
      if (typeof base !== 'string') return { result: base.note, outcome: 'failed' }
      return { result: `merge-base(${input.refA}, ${input.refB}) = ${base}`, outcome: 'no-change' }
    }
    case 'plan': {
      if (!input.groups?.length) return { result: 'plan needs groups', outcome: 'failed' }
      //  provenance-before-staging: derive which changed paths
      // Mercury itself edited this session (fileHistory) so external work
      // (operator, linter, another tool) is NAMED on the plan surface and
      // never swept into a commit unnoticed.
      const fileHistory = context.getAppState().fileHistory
      const mercuryTouched = fileHistory
        ? new Set([...fileHistory.trackedFiles].map(maybeExpandFilePath))
        : undefined
      const plan = preparePlan(owner, root, input.groups as GitPlanGroup[], mercuryTouched)
      if ('reason' in plan) return { result: `plan refused: ${plan.reason}`, outcome: 'failed' }
      const prov = plan.provenance ?? {}
      const mark = (f: string): string => (prov[f] === 'external' ? `${f} [EXTERNAL]` : f)
      const externalInGroups = plan.groups.flatMap(g => g.files).filter(f => prov[f] === 'external')
      return {
        result: [
          `${plan.id} [proposed] — ${plan.groups.length} group(s) on digest ${plan.digest}`,
          ...plan.groups.map((g, i) => `  ${i + 1}. ${g.message.split('\n')[0]} — ${g.files.map(mark).join(', ')}${g.hunks ? ` (hunk subsets: ${Object.keys(g.hunks).join(', ')})` : ''}`),
          plan.exclusions.length ? `exclusions (stay uncommitted): ${plan.exclusions.map(mark).join(', ')}` : 'no exclusions',
          externalInGroups.length ? `CAUTION: group(s) include work Mercury did not write this session — ${externalInGroups.join(', ')}; confirm these external edits belong in the commit` : '',
          plan.ambiguous.length ? `ambiguous (staged+unstaged; staging state re-derived, content never lost): ${plan.ambiguous.join(', ')}` : '',
          `NOTHING committed — apply with op:"apply" planId:"${plan.id}" (stale-safe)`,
          `record: mercury://git/plan/${plan.id}`,
        ].filter(Boolean).join('\n'),
        outcome: 'succeeded',
      }
    }
    case 'apply': {
      if (!input.planId) return { result: 'apply needs planId (gp-…)', outcome: 'failed' }
      const out = applyPlan(owner, input.planId, { signal: context.abortController?.signal })
      if (out.state === 'refused') {
        const created = out.commitsCreated?.length
          ? `\ncommits already created (they stand): ${out.commitsCreated.map(c => `${c.sha.slice(0, 8)} ${c.message.split('\n')[0]}`).join(' · ')}`
          : ''
        return { result: `apply refused [${out.code}]: ${out.reason}${created}`, outcome: 'failed' }
      }
      return {
        result: [
          `${input.planId} APPLIED — ${out.commits.length} commit(s):`,
          ...out.commits.map(c => `  ${c.sha.slice(0, 8)} ${c.message.split('\n')[0]} (${c.files.length} file(s)) — mercury://git/commit/${c.sha} · mercury://transaction/${c.transactionId}`),
          `record: mercury://git/plan/${input.planId}`,
        ].join('\n'),
        outcome: 'succeeded',
      }
    }
    case 'stage': {
      if (!input.files?.length) return { result: 'stage needs files', outcome: 'failed' }
      const out = stageSelection(root, input.files, input.hunks)
      if (out.state === 'refused') return { result: `stage refused: ${out.reason}`, outcome: 'failed' }
      return { result: out.detail, outcome: 'succeeded' }
    }
    case 'restore': {
      if (!input.files?.length) return { result: 'restore needs files', outcome: 'failed' }
      const out = restoreStaged(root, input.files)
      if (out.state === 'refused') return { result: `restore refused: ${out.reason}`, outcome: 'failed' }
      return { result: out.detail, outcome: 'succeeded' }
    }
    case 'resolve': {
      if (!input.path) return { result: 'resolve needs path', outcome: 'failed' }
      if (!input.take && input.content === undefined) {
        return { result: 'resolve needs take (ours|theirs) or content', outcome: 'failed' }
      }
      const out = resolveConflict(
        owner,
        root,
        input.path,
        input.take ? { take: input.take } : { content: input.content! },
      )
      if (out.state === 'refused') return { result: `resolve refused: ${out.reason}`, outcome: 'failed' }
      return {
        result: out.detail,
        outcome: 'succeeded',
        changedPaths: [path.resolve(root, input.path)],
      }
    }
    case 'verify': {
      if (!input.planId) return { result: 'verify needs planId', outcome: 'failed' }
      return { result: verifyPlan(owner, root, input.planId), outcome: 'no-change' }
    }
    // The compact review journey — compose, then record typed
    // findings (observational; push/comment stay with explicit workflows).
    case 'reviewContext': {
      const { composeReviewContext } = await import('../../services/repoHost/repoHost.js')
      const out = await composeReviewContext(root, {
        ...(input.pr !== undefined ? { pr: input.pr } : {}),
      })
      if (out.state !== 'ok') {
        return { result: `review context unavailable: ${out.note}\nremedy: ${out.remedy}`, outcome: 'failed' }
      }
      const c = out.context
      return {
        result: [
          `review context (${c.scope})${c.prTitle ? ` — ${c.prTitle}` : ''}:`,
          ...c.files.slice(0, 40).map(f => `  ${f.path} +${f.additions} -${f.deletions}`),
          ...(c.files.length > 40 ? [`  … +${c.files.length - 40} more`] : []),
          `impact: ${c.impactRef} · diagnostics: ${c.diagnosticsNote}`,
          ...(c.unavailable.length ? [`unavailable: ${c.unavailable.join(' · ')}`] : []),
          'record findings with op:"reviewRecord" (paths must stay inside this set) — resource: mercury://repo/review/context',
        ].join('\n'),
        outcome: 'no-change',
      }
    }
    // ── Family 2: local at-ref observation ────────────────────────────
    case 'fileAtRef': {
      if (!input.ref || !input.path) return { result: 'fileAtRef needs ref + path', outcome: 'failed' }
      const { gitFileAtRef } = await import('../../services/gitGraph/observe.js')
      const f = gitFileAtRef(root, input.ref, input.path)
      if ('state' in f) return { result: f.note, outcome: 'failed' }
      if (f.binary) {
        return {
          result: `${f.path} @ ${f.ref} — BINARY blob, ${f.bytes} byte(s); content not rendered (checkout locally to inspect)`,
          outcome: 'no-change',
        }
      }
      const lines = f.text.split('\n')
      const shown = lines.slice(0, 60)
      return {
        result: [
          `${f.path} @ ${f.ref} — ${f.bytes} byte(s), ${lines.length} line(s)${f.truncated ? ' · TRUNCATED at 400KB' : ''}`,
          ...shown,
          ...(lines.length > shown.length ? [`… +${lines.length - shown.length} more line(s) — full content: mercury://git/at/${f.ref}/${f.path}`] : [`full content: mercury://git/at/${f.ref}/${f.path}`]),
        ].join('\n'),
        outcome: 'no-change',
      }
    }
    case 'tree': {
      if (!input.ref) return { result: 'tree needs ref (and optionally path)', outcome: 'failed' }
      const { gitTreeAtRef } = await import('../../services/gitGraph/observe.js')
      const t = gitTreeAtRef(root, input.ref, input.path)
      if ('state' in t) return { result: t.note, outcome: 'failed' }
      return {
        result: [
          `${input.ref}${t.path ? `:${t.path}` : ''} — ${t.entries.length} entr${t.entries.length === 1 ? 'y' : 'ies'}${t.truncated ? ' (TRUNCATED at 500)' : ''}`,
          ...t.entries.map(e => `  ${e.type === 'tree' ? 'd' : e.type === 'blob' ? '-' : e.type[0]} ${e.name}${e.size !== null ? ` (${e.size}B)` : ''}`),
        ].join('\n'),
        outcome: 'no-change',
      }
    }
    case 'compare': {
      if (!input.refA || !input.refB) return { result: 'compare needs refA (base) + refB (head)', outcome: 'failed' }
      const { gitCompare } = await import('../../services/gitGraph/observe.js')
      const c = gitCompare(root, input.refA, input.refB)
      if ('state' in c) return { result: c.note, outcome: 'failed' }
      return {
        result: [
          `${c.base}...${c.head}: head is ${c.ahead} ahead, ${c.behind} behind · merge-base ${c.mergeBase.slice(0, 12)}`,
          ...(c.commitsAhead.length ? ['ahead:', ...c.commitsAhead.map(x => `  ${x.sha.slice(0, 8)} ${x.subject}`)] : []),
          ...(c.commitsBehind.length ? ['behind:', ...c.commitsBehind.map(x => `  ${x.sha.slice(0, 8)} ${x.subject}`)] : []),
          `files (three-dot): ${c.files.length}${c.filesTruncated ? '+ (truncated)' : ''}`,
          ...c.files.slice(0, 30).map(f => `  ${f.path} +${f.additions} -${f.deletions}`),
        ].join('\n'),
        outcome: 'no-change',
      }
    }
    // ── Family 2: host observation (read-only, gated) ────────────────
    case 'hostSearch': {
      const { repoHostEnabled, searchHost } = await import('../../services/repoHost/repoHost.js')
      if (!repoHostEnabled()) return { result: 'repository-host reads are disabled (MERCURY_REPO_HOST=0)', outcome: 'failed' }
      if (!input.searchKind || !input.query) return { result: 'hostSearch needs searchKind (code·commits·prs·issues) + query', outcome: 'failed' }
      const out = await searchHost(root, input.searchKind, input.query, input.limit)
      if (out.state !== 'ok') return { result: `${out.note}\nremedy: ${out.remedy}`, outcome: 'failed' }
      return {
        result: out.rows.length
          ? [
              `${out.kind} search: ${out.rows.length} row(s) for ${JSON.stringify(input.query)}`,
              ...out.rows.map(r => `  ${r.title}${r.detail ? ` [${r.detail}]` : ''} — ${r.repo}${r.url ? ` · ${r.url}` : ''}`),
            ].join('\n')
          : `no ${input.searchKind} results for ${JSON.stringify(input.query)}`,
        outcome: 'no-change',
      }
    }
    case 'prDiff': {
      const { repoHostEnabled, fetchPrDiffFiles, fetchPrDiffPage } = await import('../../services/repoHost/repoHost.js')
      if (!repoHostEnabled()) return { result: 'repository-host reads are disabled (MERCURY_REPO_HOST=0)', outcome: 'failed' }
      if (input.file) {
        const out = await fetchPrDiffPage(root, input.file, input.page ?? 0, input.pr)
        if (out.state !== 'ok') return { result: `${out.note}\nremedy: ${out.remedy}`, outcome: 'failed' }
        return {
          result: [
            `${out.file} (+${out.additions} -${out.deletions}) — page ${out.page + 1}/${out.pages}`,
            ...(out.incompleteNote ? [`INCOMPLETE: ${out.incompleteNote}`] : []),
            ...out.lines,
            ...(out.page + 1 < out.pages ? [`… next: page:${out.page + 1}`] : []),
          ].join('\n'),
          outcome: 'no-change',
        }
      }
      const out = await fetchPrDiffFiles(root, input.pr)
      if (out.state !== 'ok') return { result: `${out.note}\nremedy: ${out.remedy}`, outcome: 'failed' }
      return {
        result: [
          `PR diff: ${out.totalFiles} changed file(s)${out.totalFiles > out.files.length ? ` (showing ${out.files.length})` : ''} — page one with file:"<path>"${out.bounded ? ' · BOUNDED parse (200 hunks / 120 lines-per-hunk) — per-file pages may be incomplete and say so' : ''}`,
          ...out.files.map(f => `  ${f.path} +${f.additions} -${f.deletions} (${f.hunks} hunk(s))`),
        ].join('\n'),
        outcome: 'no-change',
      }
    }
    case 'runs': {
      const { repoHostEnabled, fetchRun, fetchRuns } = await import('../../services/repoHost/repoHost.js')
      if (!repoHostEnabled()) return { result: 'repository-host reads are disabled (MERCURY_REPO_HOST=0)', outcome: 'failed' }
      if (input.run) {
        const out = await fetchRun(root, input.run)
        if (out.state !== 'ok') return { result: `${out.note}\nremedy: ${out.remedy}`, outcome: 'failed' }
        const r = out.run
        return {
          result: [
            `run ${r.id} (${r.workflow}) — ${r.status}${r.conclusion ? ` / ${r.conclusion}` : ''} · ${r.title}`,
            ...r.jobs.map(j => `  ${j.name}: ${j.status}${j.conclusion ? ` / ${j.conclusion}` : ''}`),
            ...(r.url ? [r.url] : []),
          ].join('\n'),
          outcome: 'no-change',
        }
      }
      const out = await fetchRuns(root, input.limit)
      if (out.state !== 'ok') return { result: `${out.note}\nremedy: ${out.remedy}`, outcome: 'failed' }
      return {
        result: out.runs.length
          ? out.runs.map(r => `  ${r.id} [${r.status}${r.conclusion ? `/${r.conclusion}` : ''}] ${r.workflow} · ${r.branch} · ${r.title}`).join('\n')
          : 'no workflow runs on the host for this repository',
        outcome: 'no-change',
      }
    }
    case 'runWatch': {
      const { repoHostEnabled } = await import('../../services/repoHost/repoHost.js')
      if (!repoHostEnabled()) return { result: 'repository-host reads are disabled (MERCURY_REPO_HOST=0)', outcome: 'failed' }
      if (!input.run) return { result: 'runWatch needs run (the workflow-run id)', outcome: 'failed' }
      const { cancelRunWatch, watchRun } = await import('../../services/repoHost/runWatch.js')
      if (input.cancel) {
        const record = cancelRunWatch(owner, input.run)
        return record
          ? { result: `watch on run ${input.run} — stop requested (state: ${record.state})`, outcome: 'succeeded' }
          : { result: `no live watch on run ${input.run} in this conversation`, outcome: 'no-change' }
      }
      const out = await watchRun(owner, root, input.run)
      if (out.state !== 'watching') return { result: `${out.note}\nremedy: ${out.remedy}`, outcome: 'failed' }
      const v = out.view
      return {
        result: [
          `watching run ${input.run}${v ? ` (${v.workflow}) — ${v.status}${v.conclusion ? ` / ${v.conclusion}` : ''}` : ''} [execution ${out.record.state}, gen ${out.record.generation}]`,
          'the watch lives on the execution plane (RUNS lane · /tasks) and settles from the observed conclusion;',
          `check: Git op:"runs" run:"${input.run}" · cancel: op:"runWatch" run:"${input.run}" cancel:true`,
        ].join('\n'),
        outcome: 'succeeded',
      }
    }
    case 'reviewRecord': {
      const { composeReviewContext, recordReview } = await import('../../services/repoHost/repoHost.js')
      const ctx = await composeReviewContext(root, {
        ...(input.pr !== undefined ? { pr: input.pr } : {}),
      })
      if (ctx.state !== 'ok') {
        return { result: `review record unavailable: ${ctx.note}\nremedy: ${ctx.remedy}`, outcome: 'failed' }
      }
      const out = await recordReview({
        root,
        scope: ctx.context.scope,
        inspected: input.inspected ?? [],
        findings: input.findings ?? [],
        allowedPaths: ctx.context.files.map(f => f.path),
        ...(input.reviewNote ? { note: input.reviewNote } : {}),
      })
      if (out.state === 'refused') {
        return { result: `review record refused: ${out.reason}`, outcome: 'failed' }
      }
      return {
        result: `recorded review ${out.record.id} (${out.record.scope}) — ${out.record.findings.length} finding(s) · resource: mercury://repo/review/latest`,
        outcome: 'succeeded',
        changedPaths: [],
      }
    }
  }
}

const MUTATING_OPS = new Set<Input['op']>(['apply', 'stage', 'restore', 'resolve'])

export const GitTool = buildTool({
  name: 'Git',
  // Host-lane discovery is BOOT-LATCHED on MERCURY_REPO_HOST — an OFF owner
  // is never advertised; the local at-ref lane rides the tool's own gate.
  searchHint: repoHostDiscoveryEnabled()
    ? 'typed local git work graph: status diff hunks conflicts commit plans, atomic stale-safe multi-commit application; file/tree at a ref, branch compare, pull request / checks / issue context, host search, paginated PR diff, workflow-run watch via mercury://repo and the typed review record'
    : 'typed local git work graph: status diff hunks conflicts commit plans, atomic stale-safe multi-commit application; file/tree at a ref, branch compare; the typed review record',
  capability: {
    intents: [
      'inspect the local git working tree',
      'split changes into atomic commits',
      'prepare and apply a commit plan',
      'stage an exact file or hunk set',
      'inspect a local git conflict',
      'resolve a merge conflict',
      'inspect a commit or merge base',
      'read a file or tree at an exact ref',
      'compare two branches or refs',
      ...(repoHostDiscoveryEnabled()
        ? [
            'inspect this repository change on the host',
            'search code commits prs or issues on the host',
            'page through a pull request diff',
            'watch a workflow run until it settles',
          ]
        : []),
    ],
    units: ['git-inspection', 'git-transactions'],
    class: 'mutation',
    operations: [...OPS],
    transaction: { kind: 'git.commit', receipts: true },
    evidence: ['change'],
    resources: ['git'],
    preview: true,
    cancellation: 'cooperative',
    latency: 'fast',
    gate: 'MERCURY_GIT_GRAPH',
    conditions: ['a git repository at the working directory'],
    proof: 'scripts/builtin-tools/prove-git-plans.ts',
  },
  maxResultSizeChars: 60_000,
  async description() {
    return 'Typed local Git work graph: bounded observation + preview-first atomic commit plans; repository-host PR/checks/issue context and the typed review record'
  },
  async prompt() {
    return `The typed LOCAL Git work-graph surface — structured observation and preview-first, stale-safe commit transactions. It never pushes, never fetches, never rewrites history, never discards uncommitted content. (Plain Bash git remains available; use this surface when the work should be inspectable and verifiable.)

Observation (free):
- op:"status" — branch · changed files · the tree DIGEST plans pin to. mercury://git/status
- op:"diff" (scope: worktree|staged|commit|range, ref?, paths?) — bounded files + HUNKS with stable ids (gh-…) for exact staging.
- op:"show" (sha) · op:"worktree" · op:"conflicts" (three-way heads) · op:"mergebase" (refA, refB).
- op:"fileAtRef" (ref, path) — one file's content AT AN EXACT REF (full payload: mercury://git/at/<ref>/<path>). op:"tree" (ref, path?) — one directory level at a ref. op:"compare" (refA=base, refB=head) — ahead/behind counts + bounded commit lists + three-dot diffstat.

Commit plans:
- op:"plan" (groups: [{files, hunks?, message, checks?}]) — a preview-FIRST atomic plan: validates every file really changed, no file in two groups, names exclusions and ambiguous (staged+unstaged) files, pins the tree digest. COMMITS NOTHING. mercury://git/plan/<id>
- op:"apply" (planId) — revalidates the digest (a changed tree REFUSES: stale plan), then per group stages EXACTLY the planned files/hunks, commits, and VERIFIES the created commit's file list from the commit itself; one evidence-backed transaction per commit. Failure mid-plan stops honestly: created commits stand, content is never lost.
- op:"verify" (planId) — is the plan still applicable / what did it create?

Index operations (asked):
- op:"stage" (files, hunks?) — exact file/hunk staging. op:"restore" (files) — INDEX-only unstage, working copy untouched. op:"resolve" (path, take:ours|theirs or content) — resolve + stage a conflict.

Review (observational; push/comment stay with explicit workflows):
- op:"reviewContext" (pr?) — the composed review input: the reviewed diff set (worktree or PR) + the project-intel impact ref + an honest diagnostics note. mercury://repo/review/context
- op:"reviewRecord" (findings, inspected, reviewNote?, pr?) — record a TYPED review: class defect|question|polish · severity · exact path+range INSIDE the reviewed set (locations are never invented); an empty review must name what it inspected. mercury://repo/review/latest${
      repoHostDiscoveryEnabled()
        ? `
- repository-host context (read-only, via the gh session): mercury://repo · /branch · /pr/<n> · /checks/<n> · /issue/<n> — read them with Read or Inspect.`
        : ''
    }${
      repoHostDiscoveryEnabled()
        ? `

Host observation (read-only, never publishes/pushes; MERCURY_REPO_HOST):
- op:"hostSearch" (searchKind: code|commits|prs|issues, query, limit?) — bounded typed host search.
- op:"prDiff" (pr?, file?, page?) — the PR's changed-file list, or ONE file's diff a page at a time (80 lines/page; one host fetch serves every page). mercury://repo/pr/<n>/diff
- op:"runs" (limit? · run?) — workflow-run list, or one run with its jobs. mercury://repo/runs
- op:"runWatch" (run, cancel?) — a CANCELLABLE watch on one run, living on the execution plane (returns immediately; the RUNS lane tracks it; settles from the observed conclusion).`
        : ''
    }`
  },
  userFacingName,
  shouldDefer: true,
  get inputSchema(): SchemaType {
    return inputSchema()
  },
  isEnabled() {
    return gitGraphEnabled()
  },
  isConcurrencySafe(input: Input) {
    return !MUTATING_OPS.has(input?.op)
  },
  isReadOnly(input: Input) {
    return !MUTATING_OPS.has(input?.op)
  },
  async checkPermissions(input: Input) {
    if (!MUTATING_OPS.has(input.op)) {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    const what =
      input.op === 'apply'
        ? `apply commit plan ${input.planId ?? ''} (creates local commits; never pushes)`
        : input.op === 'stage'
          ? `stage ${input.files?.join(', ') ?? ''}`
          : input.op === 'restore'
            ? `unstage ${input.files?.join(', ') ?? ''} (index only, working copy untouched)`
            : `resolve conflict ${input.path ?? ''}`
    return { behavior: 'ask' as const, message: `Git ${what}` }
  },
  toAutoClassifierInput(input: Input) {
    return `git ${input.op}: ${input.planId ?? input.files?.join(' ') ?? input.path ?? input.ref ?? ''}`
  },
  async validateInput(input: Input) {
    if (!gitGraphEnabled()) {
      return { result: false as const, message: 'the git work graph is disabled (MERCURY_GIT_GRAPH=0)', errorCode: 1 }
    }
    if (input.op === 'plan' && !input.groups?.length) {
      return { result: false as const, message: 'plan requires groups', errorCode: 1 }
    }
    if ((input.op === 'apply' || input.op === 'verify') && !input.planId) {
      return { result: false as const, message: `${input.op} requires planId`, errorCode: 1 }
    }
    return { result: true as const }
  },
  async call(input: Input, context: ToolUseContext) {
    const startedAt = Date.now()
    let op: { result: string; outcome: ToolEffectOutcome; changedPaths?: string[] }
    try {
      op = await runOp(input, context)
    } catch (err) {
      op = { result: `${input.op} failed: ${(err as Error).message}`, outcome: 'failed' }
    }
    const output: Output = { op: input.op, result: op.result, outcome: op.outcome }
    const operation =
      input.op === 'apply'
        ? 'git.commit'
        : input.op === 'stage'
          ? 'git.stage'
          : input.op === 'restore'
            ? 'git.restore'
            : input.op === 'resolve'
              ? 'git.resolve'
              : `git.${input.op}`
    return {
      data: output,
      effect: {
        outcome: op.outcome,
        operation,
        changedPaths: op.changedPaths ?? [],
        evidence: op.result.split('\n')[0]?.slice(0, 160) ?? '',
        startedAt,
        completedAt: Date.now(),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseId: string) {
    return {
      tool_use_id: toolUseId,
      type: 'tool_result' as const,
      content: output.result,
    }
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  // HZ7 projection: the renderer paints `result` (status, hunks, review
  // records) — search indexes the same.
  extractSearchText({ result }) {
    return result
  },
})

export { gitGraphEnabled as isGitToolCatalogEnabled }
