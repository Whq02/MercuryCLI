// ============================================================================
//  resources/adapters/repo — repository-host context on the ONE
//  mercury:// plane. Local truth from the gitGraph owner; host truth from
//  the already-configured GitHub CLI (repoHost service — read-only,
//  bounded, 30s TTL). Absent CLI / no PR / no upstream answer as EXACT
//  typed states with remedies, never prose.
//
//    mercury://repo                — repo summary + children
//    mercury://repo/branch         — branch · head · upstream relation
//    mercury://repo/pr             — the current branch's PR
//    mercury://repo/pr/<n>         — that PR (metadata · body · files)
//    mercury://repo/checks         — check rows for the current PR
//    mercury://repo/checks/<n>     — check rows for PR <n>
//    mercury://repo/issue/<n>      — issue metadata + body
//    mercury://repo/review/context — the composed review input (diff set ·
//                                     impact ref · diagnostics note)
//    mercury://repo/review/latest  — the latest typed review record
//
//  Gate: MERCURY_REPO_HOST (kind absent when =0). Registered from tools.ts
//  beside the other feature adapters.
// ============================================================================

import type { ParsedRef, ResourceAdapter, ResourceContext, ResourceResult } from '../contracts.js'
import { registerResourceAdapter } from '../registry.js'
import {
  composeReviewContext,
  fetchChecks,
  fetchIssue,
  fetchPr,
  latestReview,
  localRepoSummary,
  repoHostEnabled,
} from '../../repoHost/repoHost.js'

function unavailable(note: string, remedy?: string): ResourceResult {
  return { state: 'unavailable', note: remedy ? `${note} — remedy: ${remedy}` : note }
}

export const repoAdapter: ResourceAdapter = {
  kind: 'repo',
  describe:
    'repository-host context (read-only): summary · branch · pr[/<n>][/diff[/<i>]] · checks[/<n>] · issue/<n> · runs · run/<id> · review/context · review/latest',
  async resolve(ref: ParsedRef, ctx?: ResourceContext): Promise<ResourceResult> {
    if (!repoHostEnabled()) {
      return unavailable('repository-host resources are disabled (MERCURY_REPO_HOST=0)')
    }
    const root = ctx?.cwd ?? process.cwd()
    const [head, ...rest] = ref.id === '' ? [''] : ref.id.split('/')

    if (head === '') {
      const s = localRepoSummary(root)
      if (s.state !== 'ok') return unavailable(s.note, s.remedy)
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://repo',
          kind: 'repo',
          title: `repository @ ${s.branch}`,
          summary: `${s.branch} @ ${s.head.slice(0, 8)}${s.upstream ? ` · ${s.upstream} +${s.ahead} -${s.behind}` : ' · no upstream'} · ${s.clean ? 'clean' : 'dirty'}`,
          mutable: false,
          children: [
            { ref: 'mercury://repo/branch', title: 'branch', summary: 'branch · head · upstream relation' },
            { ref: 'mercury://repo/pr', title: 'pull request', summary: "the current branch's PR (host)" },
            { ref: 'mercury://repo/checks', title: 'checks', summary: 'check rows for the current PR (host)' },
            { ref: 'mercury://repo/review/context', title: 'review context', summary: 'composed review input' },
            { ref: 'mercury://repo/review/latest', title: 'latest review', summary: 'the latest typed review record' },
          ],
        },
      }
    }

    if (head === 'branch') {
      const s = localRepoSummary(root)
      if (s.state !== 'ok') return unavailable(s.note, s.remedy)
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://repo/branch',
          kind: 'repo',
          title: s.branch,
          summary: `head ${s.head.slice(0, 8)} · ${s.upstream ? `upstream ${s.upstream} (+${s.ahead} ahead, -${s.behind} behind)` : 'NO upstream (never pushed or detached)'}`,
          mutable: false,
          structured: s,
        },
      }
    }

    if (head === 'pr') {
      const n = rest[0] !== undefined && rest[0] !== 'diff' ? Number(rest[0]) : undefined
      if (rest[0] !== undefined && rest[0] !== 'diff' && !Number.isSafeInteger(n)) {
        return { state: 'absent', note: `'${rest[0]}' is not a PR number` }
      }
      // Family 2: pr[/<n>]/diff — the changed-file list; /diff/<i>
      // pages ONE file (?cursor= selects the page; one host fetch serves
      // every read within the TTL).
      const diffAt = rest[0] === 'diff' ? 0 : rest[1] === 'diff' ? 1 : -1
      if (diffAt >= 0) {
        const { fetchPrDiffFiles, fetchPrDiffPage } = await import('../../repoHost/repoHost.js')
        const indexRaw = rest[diffAt + 1]
        if (indexRaw === undefined) {
          const out = await fetchPrDiffFiles(root, n)
          if (out.state !== 'ok') return unavailable(out.note, out.remedy)
          return {
            state: 'ok',
            resource: {
              ref: `mercury://repo/pr${n !== undefined ? `/${n}` : ''}/diff`,
              kind: 'repo',
              title: 'PR diff (paginated per file)',
              summary: `${out.totalFiles} changed file(s)${out.bounded ? ' · BOUNDED parse — per-file pages may be incomplete' : ''}`,
              mutable: false,
              structured: out.files,
              children: out.files.slice(0, 30).map(f => ({
                ref: `mercury://repo/pr${n !== undefined ? `/${n}` : ''}/diff/${f.index}`,
                title: f.path,
                summary: `+${f.additions} -${f.deletions} · ${f.hunks} hunk(s)`,
              })),
            },
          }
        }
        const index = Number(indexRaw)
        if (!Number.isSafeInteger(index) || index < 0) {
          return { state: 'absent', note: `'${indexRaw}' is not a diff file index` }
        }
        const listing = await fetchPrDiffFiles(root, n)
        if (listing.state !== 'ok') return unavailable(listing.note, listing.remedy)
        const row = listing.files[index]
        if (!row) return { state: 'absent', note: `diff file index ${index} out of range (${listing.files.length} files)` }
        const page = ref.selectors.cursor ?? 0
        const out = await fetchPrDiffPage(root, row.path, page, n)
        if (out.state !== 'ok') return unavailable(out.note, out.remedy)
        return {
          state: 'ok',
          resource: {
            ref: `mercury://repo/pr${n !== undefined ? `/${n}` : ''}/diff/${index}${out.page > 0 ? `?cursor=${out.page}` : ''}`,
            kind: 'repo',
            title: `${out.file} (page ${out.page + 1}/${out.pages})`,
            summary: `+${out.additions} -${out.deletions}${out.incompleteNote ? ' · INCOMPLETE (bounded parse)' : ''}`,
            mutable: false,
            text: [...(out.incompleteNote ? [`INCOMPLETE: ${out.incompleteNote}`, ''] : []), ...out.lines].join('\n'),
          },
        }
      }
      const pr = await fetchPr(root, n)
      if (pr.state !== 'ok') return unavailable(pr.note, pr.remedy)
      const p = pr.pr
      const fileRows = p.files.map(f => `  ${f.path} +${f.additions} -${f.deletions}`)
      return {
        state: 'ok',
        resource: {
          ref: `mercury://repo/pr/${p.number}`,
          kind: 'repo',
          title: `PR #${p.number}: ${p.title}`,
          summary: `${p.state} · ${p.headRefName} → ${p.baseRefName} · ${p.files.length} file(s)${p.filesTruncated ? ` (+${p.filesTruncated} truncated)` : ''}`,
          version: String(p.number),
          mutable: false,
          structured: p,
          text: [
            ...(p.url ? [p.url] : []),
            '',
            p.body || '(no body)',
            '',
            `files (${p.files.length}${p.filesTruncated ? ` of ${p.files.length + p.filesTruncated}` : ''}):`,
            ...fileRows,
          ].join('\n'),
          children: [
            { ref: `mercury://repo/checks/${p.number}`, title: 'checks', summary: 'check rows for this PR' },
          ],
        },
      }
    }

    if (head === 'checks') {
      const n = rest[0] !== undefined ? Number(rest[0]) : undefined
      if (rest[0] !== undefined && !Number.isSafeInteger(n)) {
        return { state: 'absent', note: `'${rest[0]}' is not a PR number` }
      }
      const out = await fetchChecks(root, n)
      if (out.state !== 'ok') return unavailable(out.note, out.remedy)
      return {
        state: 'ok',
        resource: {
          ref: `mercury://repo/checks${n !== undefined ? `/${n}` : ''}`,
          kind: 'repo',
          title: 'checks',
          summary: `${out.checks.length} check row(s)${out.truncated ? ` (+${out.truncated} truncated)` : ''}`,
          mutable: false,
          structured: out.checks,
          text: out.checks
            .map(c => `${c.name}\t${c.status}${c.duration ? `\t${c.duration}` : ''}${c.link ? `\t${c.link}` : ''}`)
            .join('\n'),
        },
      }
    }

    if (head === 'issue') {
      const n = Number(rest[0])
      if (!Number.isSafeInteger(n)) {
        return { state: 'absent', note: `mercury://repo/issue/<n> needs a number (got '${rest[0] ?? ''}')` }
      }
      const out = await fetchIssue(root, n)
      if (out.state !== 'ok') return unavailable(out.note, out.remedy)
      const i = out.issue
      return {
        state: 'ok',
        resource: {
          ref: `mercury://repo/issue/${i.number}`,
          kind: 'repo',
          title: `issue #${i.number}: ${i.title}`,
          summary: i.state,
          version: String(i.number),
          mutable: false,
          structured: i,
          text: [...(i.url ? [i.url] : []), '', i.body || '(no body)'].join('\n'),
        },
      }
    }

    // Family 2: workflow-run observation.
    if (head === 'runs') {
      const { fetchRuns } = await import('../../repoHost/repoHost.js')
      const out = await fetchRuns(root, ref.selectors.limit)
      if (out.state !== 'ok') return unavailable(out.note, out.remedy)
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://repo/runs',
          kind: 'repo',
          title: 'workflow runs',
          summary: `${out.runs.length} run(s)`,
          mutable: true,
          structured: out.runs,
          children: out.runs.map(r => ({
            ref: `mercury://repo/run/${r.id}`,
            title: `${r.workflow} · ${r.title}`,
            summary: `${r.status}${r.conclusion ? ` / ${r.conclusion}` : ''} · ${r.branch}`,
          })),
        },
      }
    }
    if (head === 'run') {
      const id = rest[0]
      if (!id) return { state: 'absent', note: 'mercury://repo/run/<id> needs a run id' }
      const { fetchRun } = await import('../../repoHost/repoHost.js')
      const out = await fetchRun(root, id)
      if (out.state !== 'ok') return unavailable(out.note, out.remedy)
      const r = out.run
      return {
        state: 'ok',
        resource: {
          ref: `mercury://repo/run/${r.id}`,
          kind: 'repo',
          title: `run ${r.id} (${r.workflow})`,
          summary: `${r.status}${r.conclusion ? ` / ${r.conclusion}` : ''} · ${r.title}`,
          version: r.id,
          mutable: r.status !== 'completed',
          structured: r,
          text: [
            r.title,
            `${r.status}${r.conclusion ? ` / ${r.conclusion}` : ''}`,
            ...r.jobs.map(j => `  ${j.name}: ${j.status}${j.conclusion ? ` / ${j.conclusion}` : ''}`),
            ...(r.url ? [r.url] : []),
          ].join('\n'),
        },
      }
    }
    if (head === 'review') {
      const sub = rest[0]
      if (sub === 'context') {
        const out = await composeReviewContext(root)
        if (out.state !== 'ok') return unavailable(out.note, out.remedy)
        const c = out.context
        return {
          state: 'ok',
          resource: {
            ref: 'mercury://repo/review/context',
            kind: 'repo',
            title: `review context (${c.scope})`,
            summary: `${c.files.length} file(s) · ${c.hunkCount} hunk(s)${c.truncated ? ' (bounded)' : ''} · ${c.diagnosticsNote}`,
            mutable: false,
            structured: c,
            text: [
              ...(c.prTitle ? [`PR: ${c.prTitle}`, ''] : []),
              `files:`,
              ...c.files.map(f => `  ${f.path} +${f.additions} -${f.deletions}`),
              '',
              `impact: ${c.impactRef}`,
              `diagnostics: ${c.diagnosticsNote}`,
              ...(c.unavailable.length ? ['', `unavailable: ${c.unavailable.join(' · ')}`] : []),
            ].join('\n'),
          },
        }
      }
      if (sub === 'latest') {
        const record = latestReview(root)
        if (!record) {
          return { state: 'absent', note: 'no recorded review yet — record one with Git op:"reviewRecord"' }
        }
        return {
          state: 'ok',
          resource: {
            ref: 'mercury://repo/review/latest',
            kind: 'repo',
            title: `review ${record.id} (${record.scope})`,
            summary: `${record.findings.length} finding(s) · inspected ${record.inspected.length} item(s)`,
            version: record.id,
            mutable: false,
            structured: record,
            text: record.findings.length
              ? record.findings
                  .map(
                    (f, i) =>
                      `${i + 1}. [${f.class}/${f.severity}] ${f.path}:${f.range} — ${f.claim}\n   evidence: ${f.evidence}\n   next: ${f.nextAction}`,
                  )
                  .join('\n')
              : `no supported findings.\ninspected: ${record.inspected.join(', ')}${record.note ? `\n${record.note}` : ''}`,
          },
        }
      }
      return { state: 'absent', note: `mercury://repo/review/<context|latest> (got '${sub ?? ''}')` }
    }

    return { state: 'absent', note: `unknown repo resource '${ref.id}' — try mercury://repo` }
  },
}

registerResourceAdapter(repoAdapter)
